import { invoke } from "@tauri-apps/api/core"
import { clearWechatOaTokenCache, getWechatOaAccessToken } from "./auth"

const mockInvoke = invoke as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

beforeEach(() => {
  mockInvoke.mockReset()
  clearWechatOaTokenCache("app", "sec")
})

describe("getWechatOaAccessToken", () => {
  it("returns and caches the access token", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { access_token: "tk", expires_in: 7200 }))
    await expect(getWechatOaAccessToken("app", "sec")).resolves.toBe("tk")
    await getWechatOaAccessToken("app", "sec")
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it("throws with the WeChat error message", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { errcode: 40013, errmsg: "invalid appid" }))
    await expect(getWechatOaAccessToken("app", "sec")).rejects.toThrow("invalid appid")
  })
})
