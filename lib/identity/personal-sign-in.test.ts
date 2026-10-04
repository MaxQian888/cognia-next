import { settlePersonalSignIn, signInToOfficialAccount } from "./personal-sign-in"
import { officialDeployment } from "./official-deployment"
import { IDENTITIES_CLAIM } from "./issuer-identities"

import type { LogtoClientConfig, LogtoDrivers, LogtoSession } from "@/lib/logto/client"
import type { SignedInIdentity } from "./sign-in"

const ISSUER = "https://id.cognia.cn/api/auth"
const USER = "usr_0123456789abcdef0123456789abcdef"

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

function session(identities?: unknown[]): LogtoSession {
  return {
    issuer: ISSUER,
    clientId: "cognia-app",
    resource: "https://sync.cognia.cn",
    accessToken: token({ iss: ISSUER, sub: USER }),
    ...(identities ? { idToken: token({ sub: USER, [IDENTITIES_CLAIM]: identities }) } : {}),
    scopes: [],
    issuerKind: "oidc",
  }
}

function signedIn(): SignedInIdentity {
  return {
    user: { id: USER, displayName: "Ada", createdAt: 1, updatedAt: 1 },
    binding: {
      localAccountId: "acct_a",
      userId: USER,
      logtoSubject: USER,
      logtoIssuer: ISSUER,
      createdAt: 1,
      updatedAt: 1,
    } as SignedInIdentity["binding"],
  }
}

const lark = { provider: "lark", tenant: "tenant_1", subject: "on_union_1" }
const drivers: LogtoDrivers = { openUrl: jest.fn(), waitForCode: jest.fn() }

describe("settlePersonalSignIn", () => {
  it("binds the person, links their sign-ins, and joins the Feishu principals", async () => {
    const complete = jest.fn(async () => signedIn())
    const linked = { userId: USER, provider: "lark" as const, subject: "on_union_1" }
    const linkIdentities = jest.fn(async () => ({
      linked: [linked] as never,
      conflicts: [],
      skipped: [],
    }))
    const attachPrincipals = jest.fn(async () => ({ attached: ["p1"], foreign: [] }))

    const result = await settlePersonalSignIn(session([lark]), {
      localAccountId: "acct_a",
      complete,
      linkIdentities,
      attachPrincipals,
      now: () => 42,
    })

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ issuerKind: "oidc" }), {
      localAccountId: "acct_a",
    })
    expect(linkIdentities).toHaveBeenCalledWith({ userId: USER, identities: [lark] })
    expect(attachPrincipals).toHaveBeenCalledWith({
      userId: USER,
      logtoSubject: USER,
      identities: [linked],
      now: 42,
    })
    expect(result.identity.user.id).toBe(USER)
    expect(result.identityConflicts).toEqual([])
  })

  it("reports conflicts and links nothing it was not asked to", async () => {
    const conflict = {
      provider: "lark" as const,
      subject: "on_union_1",
      tenant: "tenant_1",
      existingUserId: "usr_someone_else",
    }
    const attachPrincipals = jest.fn()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const result = await settlePersonalSignIn(session([lark]), {
      localAccountId: "acct_a",
      complete: async () => signedIn(),
      linkIdentities: async () => ({ linked: [], conflicts: [conflict], skipped: [] }),
      attachPrincipals,
    })
    expect(result.identityConflicts).toEqual([conflict])
    expect(attachPrincipals).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("skips linking when the token lists no sign-ins", async () => {
    const linkIdentities = jest.fn()
    await settlePersonalSignIn(session(), {
      localAccountId: "acct_a",
      complete: async () => signedIn(),
      linkIdentities,
    })
    expect(linkIdentities).not.toHaveBeenCalled()
  })

  it("keeps the person signed in when linking fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const result = await settlePersonalSignIn(session([lark]), {
      localAccountId: "acct_a",
      complete: async () => signedIn(),
      linkIdentities: async () => {
        throw new Error("db closed")
      },
    })
    expect(result.identity.user.id).toBe(USER)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("lets a refused binding surface, because then there is no person", async () => {
    await expect(
      settlePersonalSignIn(session(), {
        localAccountId: "acct_a",
        complete: async () => {
          throw new Error("already bound")
        },
      })
    ).rejects.toThrow("already bound")
  })
})

describe("signInToOfficialAccount", () => {
  it("signs in with the official client and the provider hint, then settles", async () => {
    let seen: LogtoClientConfig | undefined
    const signIn = jest.fn(async (config: LogtoClientConfig) => {
      seen = config
      return session()
    })
    const complete = jest.fn(async () => signedIn())

    await signInToOfficialAccount(
      officialDeployment({})!,
      drivers,
      {
        redirectUri: "cn.cognia.app:/auth/callback",
        clientKind: "native",
        socialProvider: "github",
      },
      { localAccountId: "acct_a", signIn, complete }
    )

    expect(seen).toMatchObject({
      issuer: ISSUER,
      clientId: "cognia-app",
      socialProvider: "github",
      issuerKind: "oidc",
    })
    expect(signIn).toHaveBeenCalledWith(expect.anything(), drivers, { localAccountId: "acct_a" })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})
