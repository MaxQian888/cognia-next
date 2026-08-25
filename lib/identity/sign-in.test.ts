/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { ACCOUNT_REGISTRY_DB_NAME, CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import { isOrgId, isUserId } from "@/types/identity"

import {
  SignInError,
  bindSignedInIdentity,
  deriveOrgId,
  deriveUserId,
  resolveIdentityFromClaims,
  type IdentityProjectionWriter,
  type SignedInIdentity,
} from "./sign-in"
import { readLogtoIdentity } from "./logto-claims"
import { UserBindingError, UserBindingRegistry } from "./user-binding"

import type { LogtoSession } from "@/lib/logto/client"

const ISSUER = "https://logto.example.com/oidc"

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

function session(access: Record<string, unknown>, id?: Record<string, unknown>): LogtoSession {
  return {
    issuer: ISSUER,
    clientId: "app_1",
    resource: "https://api.cognia.local",
    accessToken: token({ sub: "logto_ada", ...access }),
    ...(id ? { idToken: token(id) } : {}),
    scopes: [],
  }
}

async function freshRegistry(testName: string) {
  const name = `${ACCOUNT_REGISTRY_DB_NAME}-signin-${testName.replace(/[^a-z0-9_-]/gi, "-")}`
  const cleanup = new CogniaAccountRegistryDB(name)
  await cleanup.delete()
  return new UserBindingRegistry(new CogniaAccountRegistryDB(name))
}

describe("id derivation", () => {
  it("produces ids its own validators accept", async () => {
    expect(isUserId(await deriveUserId(ISSUER, "logto_ada"))).toBe(true)
    expect(isOrgId(await deriveOrgId(ISSUER, "org_tenant_1"))).toBe(true)
  })

  it("is stable for one subject, so two machines agree without a server", async () => {
    expect(await deriveUserId(ISSUER, "logto_ada")).toBe(await deriveUserId(ISSUER, "logto_ada"))
  })

  it("separates subjects, issuers, and the two id spaces", async () => {
    expect(await deriveUserId(ISSUER, "a")).not.toBe(await deriveUserId(ISSUER, "b"))
    expect(await deriveUserId(ISSUER, "a")).not.toBe(await deriveUserId("https://other/oidc", "a"))
    // A user and an org built from the same string must not collide.
    const asUser = await deriveUserId(ISSUER, "same")
    const asOrg = await deriveOrgId(ISSUER, "same")
    expect(asUser.slice(4)).not.toBe(asOrg.slice(4))
  })
})

describe("resolveIdentityFromClaims", () => {
  const at = 1_000

  it("prefers the asserted name, then email, then the raw subject", async () => {
    const withName = readLogtoIdentity(session({}, { name: "Ada", email: "a@x.dev" }))!
    expect((await resolveIdentityFromClaims(withName, ISSUER, at)).user).toMatchObject({
      displayName: "Ada",
      email: "a@x.dev",
    })

    const emailOnly = readLogtoIdentity(session({}, { email: "a@x.dev" }))!
    expect((await resolveIdentityFromClaims(emailOnly, ISSUER, at)).user.displayName).toBe(
      "a@x.dev"
    )

    const bare = readLogtoIdentity(session({}))!
    expect((await resolveIdentityFromClaims(bare, ISSUER, at)).user.displayName).toBe("logto_ada")
  })

  it("omits an Org entirely when the token carried no organization", async () => {
    const resolved = await resolveIdentityFromClaims(readLogtoIdentity(session({}))!, ISSUER, at)
    expect(resolved.org).toBeUndefined()
    expect(resolved.orgRole).toBeUndefined()
  })

  it("mirrors the Logto organization and carries the derived role", async () => {
    const identity = readLogtoIdentity(
      session({ organization_id: "org_tenant_1", organization_roles: ["admin"] })
    )!
    const resolved = await resolveIdentityFromClaims(identity, ISSUER, at)
    expect(resolved.org).toMatchObject({ logtoOrganizationId: "org_tenant_1" })
    expect(isOrgId(resolved.org!.id)).toBe(true)
    expect(resolved.orgRole).toBe("admin")
  })

  it("keeps the Logto organization id as a mirror, never as the key", async () => {
    const identity = readLogtoIdentity(session({ organization_id: "org_tenant_1" }))!
    const { org } = await resolveIdentityFromClaims(identity, ISSUER, at)
    expect(org!.id).not.toBe("org_tenant_1")
  })
})

describe("bindSignedInIdentity", () => {
  it("binds the profile to the person the token describes", async () => {
    const registry = await freshRegistry("bind")
    const result = await bindSignedInIdentity(
      session({ organization_id: "org_tenant_1", organization_roles: ["admin"] }, { name: "Ada" }),
      { localAccountId: "acct_alpha", registry, now: () => 1_000 }
    )

    expect(result.user.displayName).toBe("Ada")
    expect(result.orgRole).toBe("admin")
    expect(result.binding).toMatchObject({
      localAccountId: "acct_alpha",
      userId: result.user.id,
      orgId: result.org!.id,
      logtoSubject: "logto_ada",
      logtoIssuer: ISSUER,
    })
    expect(await registry.get("acct_alpha")).toMatchObject({ userId: result.user.id })
  })

  it("refuses a token with no subject rather than inventing a person", async () => {
    const registry = await freshRegistry("no-subject")
    const broken = { ...session({}), accessToken: "not-a-token" }
    await expect(
      bindSignedInIdentity(broken, { localAccountId: "acct_alpha", registry })
    ).rejects.toThrow(SignInError)
    expect(await registry.get("acct_alpha")).toBeNull()
  })

  it("refuses to take a profile that belongs to somebody else", async () => {
    const registry = await freshRegistry("conflict")
    await bindSignedInIdentity(session({}), { localAccountId: "acct_alpha", registry })
    await expect(
      bindSignedInIdentity(session({ sub: "logto_bob" }), {
        localAccountId: "acct_alpha",
        registry,
      })
    ).rejects.toThrow(UserBindingError)
  })

  it("takes it over only when the caller says so explicitly", async () => {
    const registry = await freshRegistry("takeover")
    const first = await bindSignedInIdentity(session({}), {
      localAccountId: "acct_alpha",
      registry,
    })
    const second = await bindSignedInIdentity(session({ sub: "logto_bob" }), {
      localAccountId: "acct_alpha",
      registry,
      takeOverProfile: true,
    })
    expect(second.user.id).not.toBe(first.user.id)
    expect(await registry.get("acct_alpha")).toMatchObject({ logtoSubject: "logto_bob" })
  })

  it("signs the same person in twice without duplicating anything", async () => {
    const registry = await freshRegistry("idempotent")
    const first = await bindSignedInIdentity(session({}), {
      localAccountId: "acct_alpha",
      registry,
      now: () => 1_000,
    })
    const second = await bindSignedInIdentity(session({}), {
      localAccountId: "acct_alpha",
      registry,
      now: () => 2_000,
    })
    expect(second.user.id).toBe(first.user.id)
    expect(second.binding.boundAt).toBe(1_000)
    expect(await registry.listAll()).toHaveLength(1)
  })

  it("feeds the projection seam once the binding has actually landed", async () => {
    const registry = await freshRegistry("projection")
    const seen: SignedInIdentity[] = []
    const projection: IdentityProjectionWriter = {
      upsert: async (identity) => {
        seen.push(identity)
      },
    }
    await bindSignedInIdentity(session({ organization_id: "org_tenant_1" }), {
      localAccountId: "acct_alpha",
      registry,
      projection,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].binding.localAccountId).toBe("acct_alpha")
    expect(seen[0].org).toBeDefined()
  })

  it("does not write the projection when the binding was refused", async () => {
    const registry = await freshRegistry("projection-refused")
    await bindSignedInIdentity(session({}), { localAccountId: "acct_alpha", registry })
    const projection: IdentityProjectionWriter = { upsert: jest.fn() }
    await expect(
      bindSignedInIdentity(session({ sub: "logto_bob" }), {
        localAccountId: "acct_alpha",
        registry,
        projection,
      })
    ).rejects.toThrow(UserBindingError)
    expect(projection.upsert).not.toHaveBeenCalled()
  })
})
