import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken, clearTokenCache, buildLarkOAuthUrl } from "./auth"

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
