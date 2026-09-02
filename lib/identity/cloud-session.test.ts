jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: jest.fn(() => "acct_active"),
}))

import type { UserBindingRow } from "@/lib/accounts/account-db"
import type { LogtoSessionResolution } from "@/lib/logto/app-session"
import type { LogtoSession } from "@/lib/logto/client"

import {
  cloudSessionNeedsReauth,
  isCloudSessionActive,
  readCloudSessionState,
  summarizeIdentity,
} from "./cloud-session"

function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${body}.sig`
}

function session(over: Partial<LogtoSession> = {}): LogtoSession {
  return {
    issuer: "https://logto.test/oidc",
    clientId: "app_1",
    resource: "https://api.test",
    accessToken: jwt({
      sub: "logto-ada",
      organization_id: "lorg_1",
      organization_roles: ["admin"],
      scope: "openid",
    }),
    idToken: jwt({ name: "Ada Lovelace", email: "ada@example.test" }),
    scopes: ["openid"],
    expiresAt: 10_000,
    ...over,
  }
}

function binding(over: Partial<UserBindingRow> = {}): UserBindingRow {
  return {
    localAccountId: "acct_active",
    userId: "usr_ada00000000000000000000",
    logtoSubject: "logto-ada",
    logtoIssuer: "https://logto.test/oidc",
    orgId: "org_acme0000000000000000000",
    boundAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const resolveAs = (resolution: LogtoSessionResolution) => jest.fn(async () => resolution)

describe("readCloudSessionState", () => {
  it("is signed-out when the keyring holds nothing", async () => {
    const state = await readCloudSessionState({ resolve: resolveAs({ status: "none" }) })
    expect(state).toEqual({ status: "signed-out" })
    expect(isCloudSessionActive(state)).toBe(false)
    expect(cloudSessionNeedsReauth(state)).toBe(false)
  })

  it("is active only with a token AND a binding, and carries the person", async () => {
    const s = session()
    const registry = { get: jest.fn(async () => binding()) }
    const resolve = resolveAs({ status: "active", session: s })
    const state = await readCloudSessionState({ resolve, registry })

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ localAccountId: "acct_active" }))
    expect(registry.get).toHaveBeenCalledWith("acct_active")
    expect(isCloudSessionActive(state)).toBe(true)
    if (state.status !== "active") throw new Error("unreachable")
    expect(state.session).toBe(s)
    expect(state.identity).toEqual({
      userId: "usr_ada00000000000000000000",
      logtoSubject: "logto-ada",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      orgId: "org_acme0000000000000000000",
      logtoOrganizationId: "lorg_1",
      orgRole: "admin",
    })
  })

  it("a token with no binding is reauth-required (binding-missing), never active", async () => {
    // A crash between saving the token and writing the binding leaves exactly
    // this. Acting on it would be acting as nobody in particular.
    const s = session()
    const state = await readCloudSessionState({
      resolve: resolveAs({ status: "active", session: s }),
      registry: { get: jest.fn(async () => null) },
    })
    expect(state).toEqual({
      status: "reauth-required",
      reason: "binding-missing",
      sessionMetadata: {
        issuer: s.issuer,
        clientId: "app_1",
        resource: "https://api.test",
        scopes: ["openid"],
        expiresAt: 10_000,
      },
    })
    expect(cloudSessionNeedsReauth(state)).toBe(true)
    expect(JSON.stringify(state)).not.toContain(s.accessToken)
  })

  it("passes the issuer's reauth reason and metadata through", async () => {
    const metadata = { issuer: "i", clientId: "c", resource: "r", scopes: [] as string[] }
    const registry = { get: jest.fn() }
    const state = await readCloudSessionState({
      resolve: resolveAs({ status: "reauth-required", reason: "revoked", metadata }),
      registry,
    })
    expect(state).toEqual({
      status: "reauth-required",
      reason: "revoked",
      sessionMetadata: metadata,
    })
    // No binding lookup: there is no token to be anybody with.
    expect(registry.get).not.toHaveBeenCalled()
  })

  it("offline keeps the person's metadata and is neither active nor reauth", async () => {
    const metadata = { issuer: "i", clientId: "c", resource: "r", scopes: [] as string[] }
    const state = await readCloudSessionState({
      resolve: resolveAs({ status: "offline", metadata }),
    })
    expect(state).toEqual({ status: "offline", sessionMetadata: metadata })
    expect(isCloudSessionActive(state)).toBe(false)
    expect(cloudSessionNeedsReauth(state)).toBe(false)
  })

  it("error carries the issuer's reason", async () => {
    const metadata = { issuer: "i", clientId: "c", resource: "r", scopes: [] as string[] }
    const state = await readCloudSessionState({
      resolve: resolveAs({ status: "error", reason: "invalid_client", metadata }),
    })
    expect(state).toEqual({ status: "error", reason: "invalid_client", sessionMetadata: metadata })
  })

  it("honours an explicit profile id over the active one", async () => {
    const resolve = resolveAs({ status: "none" })
    await readCloudSessionState({ resolve, localAccountId: "acct_other" })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ localAccountId: "acct_other" }))
  })
})

describe("summarizeIdentity", () => {
  it("prefers what the binding recorded over what the token says now", async () => {
    const summary = summarizeIdentity(
      session(),
      binding({ displayName: "Ada (bound)", email: "bound@example.test" })
    )
    expect(summary.displayName).toBe("Ada (bound)")
    expect(summary.email).toBe("bound@example.test")
  })

  it("omits the org fields for a personal (non-organization) token", () => {
    const summary = summarizeIdentity(
      session({ accessToken: jwt({ sub: "logto-ada", scope: "openid" }) }),
      binding({ orgId: undefined })
    )
    expect(summary).not.toHaveProperty("orgId")
    expect(summary).not.toHaveProperty("logtoOrganizationId")
    expect(summary).not.toHaveProperty("orgRole")
  })
})
