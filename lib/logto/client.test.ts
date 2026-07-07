import { loginToLogto, refreshLogtoToken, type LogtoClientConfig } from "./client"

const DISCOVERY = {
  issuer: "https://logto.test/oidc",
  authorization_endpoint: "https://logto.test/oidc/auth",
  token_endpoint: "https://logto.test/oidc/token",
}

/** A fetch mock that routes discovery vs. token by URL. */
function routingFetch(opts?: {
  token?: Record<string, unknown>
  tokenStatus?: number
}): typeof fetch {
  return jest.fn(async (url: string) => {
    if (String(url).includes("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(DISCOVERY), { status: 200 })
    }
    return new Response(
      JSON.stringify(
        opts?.token ?? {
          access_token: "at",
          refresh_token: "rt",
          id_token: "idt",
          expires_in: 3600,
          scope: "openid brain:rpc",
        }
      ),
      { status: opts?.tokenStatus ?? 200 }
    )
  }) as unknown as typeof fetch
}

const baseConfig = (over?: Partial<LogtoClientConfig>): LogtoClientConfig => ({
  issuer: "https://logto.test/oidc",
  clientId: "cli-1",
  redirectUri: "http://127.0.0.1:9321/callback",
  resource: "https://brain.test/api",
  scopes: ["brain:rpc"],
  ...over,
})

function tokenBody(fetchImpl: typeof fetch): URLSearchParams {
  const calls = (fetchImpl as jest.Mock).mock.calls
  const tokenCall = calls.find((c) => String(c[0]).endsWith("/token"))
  return new URLSearchParams((tokenCall![1] as RequestInit).body as string)
}

describe("loginToLogto", () => {
  it("logs in via PKCE and binds the session to the resource + organization", async () => {
    const fetchImpl = routingFetch()
    const openUrl = jest.fn()
    const waitForCode = jest.fn(async ({ state }: { state: string }) => ({
      code: "the-code",
      state,
    }))
    const session = await loginToLogto(baseConfig({ organizationId: "org_9" }), {
      openUrl,
      waitForCode,
      fetchImpl,
    })

    expect(session.accessToken).toBe("at")
    expect(session.refreshToken).toBe("rt")
    expect(session.idToken).toBe("idt")
    expect(session.resource).toBe("https://brain.test/api")
    expect(session.organizationId).toBe("org_9")
    expect(session.expiresAt).toBeGreaterThan(0)

    // Authorize URL carries the resource indicator and openid/offline_access.
    const authUrl = new URL((openUrl.mock.calls[0] as string[])[0])
    expect(authUrl.searchParams.get("resource")).toBe("https://brain.test/api")
    const scope = authUrl.searchParams.get("scope") ?? ""
    expect(scope).toContain("openid")
    expect(scope).toContain("offline_access")
    expect(scope).toContain("brain:rpc")

    // Token exchange carries resource + organization_id (so `aud` = resource
    // and the token gains an organization_id claim the Rust gateway reads).
    const body = tokenBody(fetchImpl)
    expect(body.get("resource")).toBe("https://brain.test/api")
    expect(body.get("organization_id")).toBe("org_9")
  })

  it("omits organization_id when no organization is configured", async () => {
    const fetchImpl = routingFetch()
    await loginToLogto(baseConfig(), {
      openUrl: jest.fn(),
      waitForCode: jest.fn(async ({ state }: { state: string }) => ({ code: "c", state })),
      fetchImpl,
    })
    expect(tokenBody(fetchImpl).get("organization_id")).toBeNull()
  })

  it("defaults scopes to openid + offline_access when none are configured", async () => {
    const fetchImpl = routingFetch()
    const openUrl = jest.fn()
    await loginToLogto(baseConfig({ scopes: undefined }), {
      openUrl,
      waitForCode: jest.fn(async ({ state }: { state: string }) => ({ code: "c", state })),
      fetchImpl,
    })
    const scope = new URL((openUrl.mock.calls[0] as string[])[0]).searchParams.get("scope") ?? ""
    expect(scope.split(" ").sort()).toEqual(["offline_access", "openid"])
  })
})

describe("refreshLogtoToken", () => {
  it("uses the refresh grant with resource + org and preserves the old refresh token", async () => {
    // Response omits refresh_token — the client must keep the supplied one.
    const fetchImpl = routingFetch({ token: { access_token: "at2", expires_in: 3600 } })
    const session = await refreshLogtoToken(
      baseConfig({ organizationId: "org_9" }),
      "old-refresh",
      fetchImpl
    )
    expect(session.accessToken).toBe("at2")
    expect(session.refreshToken).toBe("old-refresh")

    const body = tokenBody(fetchImpl)
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("old-refresh")
    expect(body.get("resource")).toBe("https://brain.test/api")
    expect(body.get("organization_id")).toBe("org_9")
  })

  it("throws when the refresh grant fails", async () => {
    const fetchImpl = routingFetch({ tokenStatus: 400 })
    await expect(refreshLogtoToken(baseConfig(), "r", fetchImpl)).rejects.toThrow(/refresh failed/i)
  })
})
