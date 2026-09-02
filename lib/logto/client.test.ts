import {
  buildLogtoEndSessionUrl,
  loginToLogto,
  LogtoRefreshError,
  refreshLogtoToken,
  revokeLogtoToken,
  toLogtoSessionMetadata,
  type LogtoClientConfig,
} from "./client"

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

  it("throws a typed error when the refresh grant fails", async () => {
    const fetchImpl = routingFetch({ tokenStatus: 400 })
    await expect(refreshLogtoToken(baseConfig(), "r", fetchImpl)).rejects.toThrow(/refresh failed/i)
    await expect(refreshLogtoToken(baseConfig(), "r", fetchImpl)).rejects.toBeInstanceOf(
      LogtoRefreshError
    )
  })
})

describe("refreshLogtoToken failure classification", () => {
  const tokenFailure = (status: number, body?: unknown, throwing?: Error): typeof fetch =>
    jest.fn(async (url: string) => {
      if (String(url).includes("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(DISCOVERY), { status: 200 })
      }
      if (throwing) throw throwing
      return new Response(body === undefined ? "" : JSON.stringify(body), { status })
    }) as unknown as typeof fetch

  it("invalid_grant is permanent and carries the issuer's description", async () => {
    const fetchImpl = tokenFailure(400, {
      error: "invalid_grant",
      error_description: "refresh token is expired",
    })
    const error = await refreshLogtoToken(baseConfig(), "r", fetchImpl).catch((e) => e)
    expect(error).toBeInstanceOf(LogtoRefreshError)
    expect(error.kind).toBe("invalid_grant")
    expect(error.permanent).toBe(true)
    expect(error.transient).toBe(false)
    expect(error.status).toBe(400)
    expect(error.oauthError).toBe("invalid_grant")
    expect(error.reauthReason).toBe("expired")
  })

  it("invalid_grant without an expiry description reads as revoked", async () => {
    const fetchImpl = tokenFailure(400, { error: "invalid_grant" })
    const error = await refreshLogtoToken(baseConfig(), "r", fetchImpl).catch((e) => e)
    expect(error.reauthReason).toBe("revoked")
  })

  it("any other 4xx is rejected: not permanent, not transient", async () => {
    const fetchImpl = tokenFailure(401, { error: "invalid_client" })
    const error = await refreshLogtoToken(baseConfig(), "r", fetchImpl).catch((e) => e)
    expect(error.kind).toBe("rejected")
    expect(error.permanent).toBe(false)
    expect(error.transient).toBe(false)
    expect(error.oauthError).toBe("invalid_client")
  })

  it("a 5xx is a transient server failure", async () => {
    const fetchImpl = tokenFailure(503, { error: "temporarily_unavailable" })
    const error = await refreshLogtoToken(baseConfig(), "r", fetchImpl).catch((e) => e)
    expect(error.kind).toBe("server")
    expect(error.transient).toBe(true)
  })

  it("a non-JSON error body still classifies by status", async () => {
    const fetchImpl = tokenFailure(502)
    const error = await refreshLogtoToken(baseConfig(), "r", fetchImpl).catch((e) => e)
    expect(error.kind).toBe("server")
  })

  it("a thrown fetch is the network", async () => {
    const fetchImpl = tokenFailure(200, undefined, new TypeError("fetch failed"))
    const error = await refreshLogtoToken(baseConfig(), "r", fetchImpl).catch((e) => e)
    expect(error.kind).toBe("network")
    expect(error.transient).toBe(true)
  })

  it("a failed discovery is the network too, unless the issuer answered badly", async () => {
    const down = jest.fn(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    expect((await refreshLogtoToken(baseConfig(), "r", down).catch((e) => e)).kind).toBe("network")

    const broken = jest.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch
    expect((await refreshLogtoToken(baseConfig(), "r", broken).catch((e) => e)).kind).toBe("server")
  })

  it("a 200 without an access token is malformed", async () => {
    const fetchImpl = routingFetch({ token: { expires_in: 10 } })
    const error = await refreshLogtoToken(baseConfig(), "r", fetchImpl).catch((e) => e)
    expect(error.kind).toBe("malformed")
  })
})

describe("revokeLogtoToken", () => {
  const withRevocation = (status = 200, throwing?: Error): typeof fetch =>
    jest.fn(async (url: string) => {
      if (String(url).includes("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({ ...DISCOVERY, revocation_endpoint: "https://logto.test/oidc/revoke" }),
          { status: 200 }
        )
      }
      if (throwing) throw throwing
      return new Response("", { status })
    }) as unknown as typeof fetch

  it("posts the token with its hint and the client id to the revocation endpoint", async () => {
    const fetchImpl = withRevocation()
    const outcome = await revokeLogtoToken(baseConfig(), "rt-1", "refresh_token", fetchImpl)
    expect(outcome).toEqual({ status: "revoked" })
    const call = (fetchImpl as jest.Mock).mock.calls.find((c) => String(c[0]).endsWith("/revoke"))
    const body = new URLSearchParams((call![1] as RequestInit).body as string)
    expect(body.get("token")).toBe("rt-1")
    expect(body.get("token_type_hint")).toBe("refresh_token")
    expect(body.get("client_id")).toBe("cli-1")
  })

  it("reports an issuer with no revocation endpoint as unsupported", async () => {
    const outcome = await revokeLogtoToken(baseConfig(), "rt-1", "refresh_token", routingFetch())
    expect(outcome).toEqual({ status: "unsupported" })
  })

  it("never throws: a refusal or an unreachable issuer is a failed outcome", async () => {
    expect(await revokeLogtoToken(baseConfig(), "t", "access_token", withRevocation(500))).toEqual({
      status: "failed",
      reason: expect.stringContaining("500"),
    })
    expect(
      await revokeLogtoToken(
        baseConfig(),
        "t",
        "access_token",
        withRevocation(200, new TypeError("fetch failed"))
      )
    ).toMatchObject({ status: "failed", reason: "fetch failed" })
    const noDiscovery = jest.fn(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    expect(await revokeLogtoToken(baseConfig(), "t", "access_token", noDiscovery)).toMatchObject({
      status: "failed",
    })
  })
})

describe("buildLogtoEndSessionUrl", () => {
  it("is null when the issuer advertises no end-session endpoint", () => {
    expect(buildLogtoEndSessionUrl({}, { clientId: "c" })).toBeNull()
  })

  it("carries the client id, the id token hint and the post-logout redirect", () => {
    const url = new URL(
      buildLogtoEndSessionUrl(
        { endSessionEndpoint: "https://logto.test/oidc/session/end" },
        { clientId: "c", idToken: "idt", postLogoutRedirectUri: "https://app.test/bye" }
      )!
    )
    expect(url.searchParams.get("client_id")).toBe("c")
    expect(url.searchParams.get("id_token_hint")).toBe("idt")
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("https://app.test/bye")
  })
})

describe("toLogtoSessionMetadata", () => {
  it("drops every secret and keeps the rest", () => {
    const metadata = toLogtoSessionMetadata({
      issuer: "i",
      clientId: "c",
      resource: "r",
      organizationId: "o",
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IDT",
      expiresAt: 5,
      scopes: ["openid"],
    })
    expect(metadata).toEqual({
      issuer: "i",
      clientId: "c",
      resource: "r",
      organizationId: "o",
      expiresAt: 5,
      scopes: ["openid"],
    })
    expect(JSON.stringify(metadata)).not.toMatch(/AT|RT|IDT/)
  })
})
