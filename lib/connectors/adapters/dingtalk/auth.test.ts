const httpRequest = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: (...a: unknown[]) => httpRequest(...a),
}))

import {
  getDingTalkAccessToken,
  clearDingTalkTokenCache,
  dingtalkAuthHeaders,
  DINGTALK_API_BASE,
} from "./auth"

function ok(body: unknown) {
  return { status: 200, headers: {}, body: JSON.stringify(body) }
}

describe("dingtalk auth", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearDingTalkTokenCache("ak", "as")
  })

  it("mints and caches an access token per (appKey, appSecret)", async () => {
    httpRequest.mockResolvedValueOnce(ok({ accessToken: "tok-1", expireIn: 7200 }))
    const t1 = await getDingTalkAccessToken("ak", "as")
    expect(t1).toBe("tok-1")
    // second call within TTL is served from cache (no new request)
    const t2 = await getDingTalkAccessToken("ak", "as")
    expect(t2).toBe("tok-1")
    expect(httpRequest).toHaveBeenCalledTimes(1)
    const call = httpRequest.mock.calls[0][0]
    expect(call.url).toContain("/v1.0/oauth2/accessToken")
    expect(JSON.parse(call.body)).toEqual({ appKey: "ak", appSecret: "as" })
  })

  it("refetches after clearing the cache", async () => {
    httpRequest.mockResolvedValue(ok({ accessToken: "tok-2", expireIn: 7200 }))
    await getDingTalkAccessToken("ak", "as")
    clearDingTalkTokenCache("ak", "as")
    await getDingTalkAccessToken("ak", "as")
    expect(httpRequest).toHaveBeenCalledTimes(2)
  })

  it("defaults the TTL to 7200s when expireIn is absent", async () => {
    httpRequest.mockResolvedValueOnce(ok({ accessToken: "tok-3" }))
    const t = await getDingTalkAccessToken("ak", "as")
    expect(t).toBe("tok-3")
    // served from cache on the next call (TTL applied)
    await getDingTalkAccessToken("ak", "as")
    expect(httpRequest).toHaveBeenCalledTimes(1)
  })

  it("throws on a non-JSON or missing-token response", async () => {
    httpRequest.mockResolvedValueOnce({ status: 500, headers: {}, body: "<html>" })
    await expect(getDingTalkAccessToken("ak", "as")).rejects.toThrow(/non-JSON/)
    httpRequest.mockResolvedValueOnce(ok({ message: "invalid app" }))
    await expect(getDingTalkAccessToken("ak", "as")).rejects.toThrow(/invalid app/)
  })

  it("builds the access-token header and exposes the api base", () => {
    expect(dingtalkAuthHeaders("tok")).toEqual({
      "x-acs-dingtalk-access-token": "tok",
      "Content-Type": "application/json",
    })
    expect(DINGTALK_API_BASE).toBe("https://api.dingtalk.com")
  })
})
