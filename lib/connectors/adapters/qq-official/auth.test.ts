import { invoke } from "@tauri-apps/api/core"
import { clearQQTokenCache, getQQAccessToken, getQQGatewayUrl, qqAuthHeaders } from "./auth"

const mockInvoke = invoke as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

beforeEach(() => {
  mockInvoke.mockReset()
  clearQQTokenCache("app1", "sec1")
})

describe("getQQAccessToken", () => {
  it("fetches and returns the access token", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { access_token: "tok-1", expires_in: "7200" }))
    await expect(getQQAccessToken("app1", "sec1")).resolves.toBe("tok-1")
  })

  it("caches the token within its lifetime (single HTTP call)", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { access_token: "tok-1", expires_in: 7200 }))
    await getQQAccessToken("app1", "sec1")
    await getQQAccessToken("app1", "sec1")
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it("throws when the platform returns no token", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { message: "bad secret" }))
    await expect(getQQAccessToken("app1", "sec1")).rejects.toThrow("bad secret")
  })
})

describe("getQQGatewayUrl", () => {
  it("returns the websocket url", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { url: "wss://api.sgroup.qq.com/websocket" }))
    await expect(getQQGatewayUrl("tok")).resolves.toBe("wss://api.sgroup.qq.com/websocket")
  })

  it("throws when no url is returned", async () => {
    mockInvoke.mockResolvedValue(httpResp(500, { message: "down" }))
    await expect(getQQGatewayUrl("tok")).rejects.toThrow("down")
  })
})

describe("qqAuthHeaders", () => {
  it("uses the QQBot scheme", () => {
    expect(qqAuthHeaders("abc")).toEqual({
      Authorization: "QQBot abc",
      "Content-Type": "application/json",
    })
  })
})
