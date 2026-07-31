import { invoke } from "@tauri-apps/api/core"
import { clearWechatOaTokenCache, getWechatOaAccessToken } from "./auth"

const mockInvoke = invoke as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

beforeEach(() => {
  mockInvoke.mockReset()
  clearWechatOaTokenCache()
})

describe("getWechatOaAccessToken", () => {
  it("POSTs the stable_token endpoint with a JSON credential body", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { access_token: "tk", expires_in: 7200 }))
    await expect(getWechatOaAccessToken("app", "sec")).resolves.toBe("tk")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toBe("https://api.weixin.qq.com/cgi-bin/stable_token")
    expect(req.method).toBe("POST")
    expect(req.headers).toMatchObject({ "Content-Type": "application/json" })
    expect(JSON.parse(req.body)).toEqual({
      grant_type: "client_credential",
      appid: "app",
      secret: "sec",
    })
  })

  it("caches the token per (appId, appSecret)", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { access_token: "tk", expires_in: 7200 }))
    await getWechatOaAccessToken("app", "sec")
    await getWechatOaAccessToken("app", "sec")
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it("throws with the WeChat error message", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { errcode: 40013, errmsg: "invalid appid" }))
    await expect(getWechatOaAccessToken("app", "sec")).rejects.toThrow("invalid appid")
  })

  it("throws on a non-JSON token response", async () => {
    mockInvoke.mockResolvedValue(httpResp(502, "<html>bad gateway</html>"))
    await expect(getWechatOaAccessToken("app", "sec")).rejects.toThrow("non-JSON (status 502)")
  })
})

describe("clearWechatOaTokenCache", () => {
  it("clears one entry when a credential pair is given", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { access_token: "tk", expires_in: 7200 }))
    await getWechatOaAccessToken("app", "sec")
    clearWechatOaTokenCache("app", "sec")
    await getWechatOaAccessToken("app", "sec")
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it("clears every entry when called without arguments", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { access_token: "tk", expires_in: 7200 }))
    await getWechatOaAccessToken("a1", "s1")
    await getWechatOaAccessToken("a2", "s2")
    clearWechatOaTokenCache()
    await getWechatOaAccessToken("a1", "s1")
    await getWechatOaAccessToken("a2", "s2")
    expect(mockInvoke).toHaveBeenCalledTimes(4)
  })
})
