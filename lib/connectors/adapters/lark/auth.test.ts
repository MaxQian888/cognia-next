import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import {
  getTenantAccessToken,
  clearTokenCache,
  buildLarkOAuthUrl,
  exchangeCodeForUserAccessToken,
  refreshUserAccessToken,
} from "./auth"

const mockHttp = connectorsHttpRequest as jest.Mock

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
}))

function makeTokenResponse(token = "t-test-tat-123", expire = 7200, code = 0) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code, tenant_access_token: token, expire }),
  }
}

function makeErrorResponse(code = 99991663, msg = "Invalid app") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code, msg }),
  }
}

describe("getTenantAccessToken", () => {
  const APP_ID = "cli_test_app_001"
  const APP_SECRET = "test-secret-001"

  beforeEach(() => {
    mockHttp.mockReset()
    clearTokenCache(APP_ID, APP_SECRET)
  })

  it("fetches a token and returns it", async () => {
    mockHttp.mockResolvedValue(makeTokenResponse("t-fresh"))
    const token = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })
    expect(token).toBe("t-fresh")
    expect(mockHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("tenant_access_token/internal"),
        method: "POST",
      })
    )
  })

  it("returns the cached token on a second call without hitting the API", async () => {
    mockHttp.mockResolvedValue(makeTokenResponse("t-cached"))

    const t1 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })
    const t2 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })

    expect(t1).toBe("t-cached")
    expect(t2).toBe("t-cached")
    expect(mockHttp).toHaveBeenCalledTimes(1) // cached on second call
  })

  it("re-fetches after the cache is cleared", async () => {
    mockHttp
      .mockResolvedValueOnce(makeTokenResponse("t-first"))
      .mockResolvedValueOnce(makeTokenResponse("t-second"))

    await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })
    clearTokenCache(APP_ID, APP_SECRET)
    const t2 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })

    expect(t2).toBe("t-second")
    expect(mockHttp).toHaveBeenCalledTimes(2)
  })

  it("throws when Lark returns a non-zero code", async () => {
    mockHttp.mockResolvedValue(makeErrorResponse(99991663, "invalid_app"))
    await expect(getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })).rejects.toThrow(
      /tenant_access_token failed/
    )
  })

  it("sends appId and appSecret in the request body", async () => {
    mockHttp.mockResolvedValue(makeTokenResponse())
    await getTenantAccessToken({ appId: "cli_abc", appSecret: "sec_xyz" })

    const call = mockHttp.mock.calls[0][0] as { body: string }
    const body = JSON.parse(call.body) as { app_id: string; app_secret: string }
    expect(body.app_id).toBe("cli_abc")
    expect(body.app_secret).toBe("sec_xyz")
  })
})

describe("buildLarkOAuthUrl", () => {
  it("builds the correct authorize URL", () => {
    const url = buildLarkOAuthUrl({
      appId: "cli_my_app",
      redirectUri: "cognia://connector/oauth/lark",
      state: "random-state-123",
    })
    expect(url).toContain("open.feishu.cn")
    expect(url).toContain("authen/v1/authorize")
    expect(url).toContain("app_id=cli_my_app")
    expect(url).toContain("state=random-state-123")
  })

  it("URL-encodes the redirect_uri", () => {
    const url = buildLarkOAuthUrl({
      appId: "cli_app",
      redirectUri: "cognia://connector/oauth/lark?foo=bar",
      state: "s",
    })
    expect(url).not.toContain("cognia://connector/oauth/lark?foo=bar")
    expect(url).toContain("redirect_uri=")
  })
})

// ---------------------------------------------------------------------------
// A4 / D2 — OAuth code exchange + refresh (ADR-0009 v41)
// ---------------------------------------------------------------------------

function makeOidcResponse(opts: {
  accessToken?: string
  refreshToken?: string
  openId?: string
  name?: string
  expiresIn?: number
  refreshExpiresIn?: number
  code?: number
  msg?: string
}) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      code: opts.code ?? 0,
      msg: opts.msg,
      data:
        opts.code === undefined || opts.code === 0
          ? {
              access_token: opts.accessToken ?? "u-token",
              refresh_token: opts.refreshToken ?? "u-refresh",
              expires_in: opts.expiresIn ?? 7200,
              refresh_expires_in: opts.refreshExpiresIn ?? 31_104_000,
              open_id: opts.openId ?? "ou_default",
              union_id: "on_default",
              token_type: "Bearer",
              scope: "im:message",
              name: opts.name,
              avatar_url: "https://avatar.example.com",
              email: "user@example.com",
              enterprise_email: "user@bigcorp.example.com",
            }
          : undefined,
    }),
  }
}

describe("exchangeCodeForUserAccessToken", () => {
  beforeEach(() => {
    mockHttp.mockReset()
  })

  it("POSTs the OIDC endpoint with Bearer TAT and authorization_code grant body", async () => {
    mockHttp.mockResolvedValueOnce(
      makeOidcResponse({
        accessToken: "u-access",
        refreshToken: "u-refresh",
        openId: "ou_alice",
        name: "Alice",
      })
    )
    const result = await exchangeCodeForUserAccessToken({
      code: "abc123",
      appAccessToken: "tat-xyz",
    })
    expect(result.accessToken).toBe("u-access")
    expect(result.refreshToken).toBe("u-refresh")
    expect(result.openId).toBe("ou_alice")
    expect(result.name).toBe("Alice")
    expect(result.expiresInSec).toBe(7200)
    expect(result.refreshExpiresInSec).toBe(31_104_000)

    const call = mockHttp.mock.calls[0][0] as {
      url: string
      headers: Record<string, string>
      body: string
    }
    expect(call.url).toContain("/authen/v1/oidc/access_token")
    expect(call.headers.Authorization).toBe("Bearer tat-xyz")
    expect(JSON.parse(call.body)).toEqual({ grant_type: "authorization_code", code: "abc123" })
  })

  it("throws when Lark returns a non-zero code", async () => {
    mockHttp.mockResolvedValueOnce(makeOidcResponse({ code: 99991661, msg: "auth code expired" }))
    await expect(
      exchangeCodeForUserAccessToken({ code: "stale", appAccessToken: "tat" })
    ).rejects.toThrow(/auth code expired/)
  })

  it("throws when the response is missing access_token", async () => {
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, data: { refresh_token: "r-only" } }),
    })
    await expect(
      exchangeCodeForUserAccessToken({ code: "x", appAccessToken: "tat" })
    ).rejects.toThrow(/OIDC access_token failed/)
  })
})

describe("refreshUserAccessToken", () => {
  beforeEach(() => {
    mockHttp.mockReset()
  })

  it("POSTs the refresh endpoint with the refresh_token grant body", async () => {
    mockHttp.mockResolvedValueOnce(
      makeOidcResponse({ accessToken: "u-fresh", refreshToken: "u-rotated" })
    )
    const result = await refreshUserAccessToken({
      refreshToken: "old-refresh",
      appAccessToken: "tat",
    })
    expect(result.accessToken).toBe("u-fresh")
    // Lark may rotate the refresh token; callers must persist whatever comes back.
    expect(result.refreshToken).toBe("u-rotated")

    const call = mockHttp.mock.calls[0][0] as { url: string; body: string }
    expect(call.url).toContain("/authen/v1/oidc/refresh_access_token")
    expect(JSON.parse(call.body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    })
  })

  it("throws on non-zero refresh code", async () => {
    mockHttp.mockResolvedValueOnce(
      makeOidcResponse({ code: 99991671, msg: "refresh token expired" })
    )
    await expect(
      refreshUserAccessToken({ refreshToken: "expired", appAccessToken: "tat" })
    ).rejects.toThrow(/refresh token expired/)
  })
})
