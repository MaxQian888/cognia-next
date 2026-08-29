/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { ACCOUNT_REGISTRY_DB_NAME, CogniaAccountRegistryDB } from "@/lib/accounts/account-db"

import { completeSignIn, completeSignOut, readSignedInPerson } from "./complete-sign-in"
import { ACCOUNT_BIND_PERSON_COMMAND, ACCOUNT_UNBIND_PERSON_COMMAND } from "./host-person"
import { UserBindingError, UserBindingRegistry } from "./user-binding"
import type { IdentityProjectionWriter, SignedInIdentity } from "./sign-in"

import type { LogtoSession } from "@/lib/logto/client"

const ISSUER = "https://logto.example.com/oidc"

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

function session(access: Record<string, unknown> = {}): LogtoSession {
  return {
    issuer: ISSUER,
    clientId: "app_1",
    resource: "https://api.cognia.local",
    accessToken: token({ sub: "logto_ada", ...access }),
    scopes: [],
  }
}

async function freshRegistry(name: string) {
  const dbName = `${ACCOUNT_REGISTRY_DB_NAME}-complete-${name.replace(/[^a-z0-9_-]/gi, "-")}`
  await new CogniaAccountRegistryDB(dbName).delete()
  return new UserBindingRegistry(new CogniaAccountRegistryDB(dbName))
}

function collector() {
  const seen: SignedInIdentity[] = []
  const projection: IdentityProjectionWriter = {
    upsert: async (identity) => {
      seen.push(identity)
    },
  }
  return { seen, projection }
}

describe("completeSignIn", () => {
  it("binds, projects, and mirrors to the host in that order", async () => {
    const registry = await freshRegistry("happy")
    const { seen, projection } = collector()
    const invokeFn = jest.fn().mockResolvedValue(undefined)
    const signedIn = session({ organization_id: "org_tenant_1" })

    const identity = await completeSignIn(signedIn, {
      localAccountId: "acct_alpha",
      registry,
      projection,
      host: { invokeFn, isDesktop: () => true },
    })

    expect(await registry.get("acct_alpha")).toMatchObject({ userId: identity.user.id })
    expect(seen).toHaveLength(1)
    expect(invokeFn).toHaveBeenCalledWith(ACCOUNT_BIND_PERSON_COMMAND, {
      accessToken: signedIn.accessToken,
      userId: identity.user.id,
      orgId: identity.org!.id,
    })
  })

  it("does not undo a completed sign-in when the host mirror fails", async () => {
    // A desktop whose companion server has never started has no SecurityStore.
    const registry = await freshRegistry("host-down")
    const onHostMirrorFailed = jest.fn()

    const identity = await completeSignIn(session(), {
      localAccountId: "acct_alpha",
      registry,
      projection: collector().projection,
      host: { invokeFn: jest.fn().mockRejectedValue(new Error("no store")), isDesktop: () => true },
      onHostMirrorFailed,
    })

    expect(onHostMirrorFailed).toHaveBeenCalledTimes(1)
    expect(await registry.get("acct_alpha")).toMatchObject({ userId: identity.user.id })
  })

  it("never reaches the projection or the host when the binding is refused", async () => {
    const registry = await freshRegistry("refused")
    await completeSignIn(session(), {
      localAccountId: "acct_alpha",
      registry,
      projection: collector().projection,
      host: { invokeFn: jest.fn(), isDesktop: () => false },
    })

    const { seen, projection } = collector()
    const invokeFn = jest.fn()
    await expect(
      completeSignIn(session({ sub: "logto_bob" }), {
        localAccountId: "acct_alpha",
        registry,
        projection,
        host: { invokeFn, isDesktop: () => true },
      })
    ).rejects.toThrow(UserBindingError)

    expect(seen).toHaveLength(0)
    expect(invokeFn).not.toHaveBeenCalled()
  })

  it("takes the profile over when the caller explicitly asks", async () => {
    const registry = await freshRegistry("takeover")
    await completeSignIn(session(), {
      localAccountId: "acct_alpha",
      registry,
      projection: collector().projection,
      host: { isDesktop: () => false },
    })
    const second = await completeSignIn(session({ sub: "logto_bob" }), {
      localAccountId: "acct_alpha",
      registry,
      projection: collector().projection,
      host: { isDesktop: () => false },
      takeOverProfile: true,
    })
    expect(await registry.get("acct_alpha")).toMatchObject({ userId: second.user.id })
  })
})

describe("completeSignOut", () => {
  it("drops the binding and tells the host to forget the person", async () => {
    const registry = await freshRegistry("sign-out")
    const invokeFn = jest.fn().mockResolvedValue(undefined)
    await completeSignIn(session(), {
      localAccountId: "acct_alpha",
      registry,
      projection: collector().projection,
      host: { isDesktop: () => false },
    })

    await completeSignOut({
      localAccountId: "acct_alpha",
      registry,
      host: { invokeFn, isDesktop: () => true },
    })

    expect(await registry.get("acct_alpha")).toBeNull()
    expect(invokeFn).toHaveBeenCalledWith(ACCOUNT_UNBIND_PERSON_COMMAND)
  })

  it("is idempotent and survives a host that cannot be reached", async () => {
    const registry = await freshRegistry("sign-out-twice")
    const onHostMirrorFailed = jest.fn()
    const host = {
      invokeFn: jest.fn().mockRejectedValue(new Error("no store")),
      isDesktop: () => true,
    }

    await completeSignOut({ localAccountId: "acct_alpha", registry, host, onHostMirrorFailed })
    await completeSignOut({ localAccountId: "acct_alpha", registry, host, onHostMirrorFailed })

    expect(await registry.get("acct_alpha")).toBeNull()
    expect(onHostMirrorFailed).toHaveBeenCalledTimes(2)
  })

  it("leaves the projection alone, so names on old rows do not blank out", async () => {
    const registry = await freshRegistry("keeps-projection")
    const { seen, projection } = collector()
    await completeSignIn(session(), {
      localAccountId: "acct_alpha",
      registry,
      projection,
      host: { isDesktop: () => false },
    })
    await completeSignOut({
      localAccountId: "acct_alpha",
      registry,
      host: { isDesktop: () => false },
    })
    expect(seen).toHaveLength(1)
  })
})

describe("readSignedInPerson", () => {
  it("answers null for a profile nobody signed into", async () => {
    const registry = await freshRegistry("read-empty")
    expect(await readSignedInPerson({ localAccountId: "acct_alpha", registry })).toBeNull()
  })

  it("returns the binding after a sign-in", async () => {
    const registry = await freshRegistry("read-bound")
    const identity = await completeSignIn(session(), {
      localAccountId: "acct_alpha",
      registry,
      projection: collector().projection,
      host: { isDesktop: () => false },
    })
    expect(await readSignedInPerson({ localAccountId: "acct_alpha", registry })).toMatchObject({
      userId: identity.user.id,
      logtoSubject: "logto_ada",
    })
  })
})
