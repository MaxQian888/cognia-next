import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsHttpRequest: jest.fn() }))

import { requestLoginQr, pollLoginStatus, resolveIlinkQrRedirect, type IlinkHttp } from "./auth"

function http(body: unknown): IlinkHttp {
  return jest.fn(async () => ({ status: 200, headers: {}, body: JSON.stringify(body) }))
}

describe("requestLoginQr", () => {
  it("GETs get_bot_qrcode with bot_type=3 and ilink headers", async () => {
    const h = http({ qrcode: "qr1", qrcode_img_content: "data" })
    const res = await requestLoginQr(h, "https://base")
    expect(res.qrcode).toBe("qr1")
    const req = (h as jest.Mock).mock.calls[0][0]
    expect(req.url).toBe("https://base/ilink/bot/get_bot_qrcode?bot_type=3")
    expect(req.method).toBe("GET")
    expect(req.headers.AuthorizationType).toBe("ilink_bot_token")
    expect(req.headers.Authorization).toBeUndefined()
  })
})

describe("pollLoginStatus", () => {
  it("returns bot_token + baseurl on confirm", async () => {
    const h = http({ status: "confirmed", bot_token: "tok", baseurl: "https://srv" })
    const res = await pollLoginStatus("qr1", h, "https://base")
    expect(res.status).toBe("confirmed")
    expect(res.bot_token).toBe("tok")
    expect(res.baseurl).toBe("https://srv")
    const req = (h as jest.Mock).mock.calls[0][0]
    expect(req.url).toBe("https://base/ilink/bot/get_qrcode_status?qrcode=qr1")
  })

  it("returns the pending status while waiting", async () => {
    const h = http({ status: "wait" })
    const res = await pollLoginStatus("qr1", h)
    expect(res.status).toBe("wait")
    expect(res.bot_token).toBeUndefined()
  })
})

describe("current iLink login protocol", () => {
  it("encodes verification codes, uses the long-poll timeout and preserves official identity", async () => {
    const h = http({
      status: "confirmed",
      bot_token: "token",
      ilink_bot_id: "bot-id",
      ilink_user_id: "user-id",
      baseurl: "https://ilinkai.weixin.qq.com/",
    })
    const response = await pollLoginStatus("qr & id", h, "https://ilinkai.weixin.qq.com/", "123456")
    const request = (h as jest.Mock).mock.calls[0][0]
    expect(request.url).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr%20%26%20id&verify_code=123456"
    )
    expect(request.timeoutMs).toBe(35000)
    expect(response).toMatchObject({
      account_id: "bot-id",
      ilink_user_id: "user-id",
      baseurl: "https://ilinkai.weixin.qq.com",
    })
  })
  it.each(["need_verifycode", "verify_code_blocked", "binded_redirect", "scaned_but_redirect"])(
    "preserves %s status",
    async (status) => {
      expect(
        await pollLoginStatus("qr", http({ status, redirect_host: "ilinkai.weixin.qq.com" }))
      ).toMatchObject({ status })
    }
  )
  it.each([
    null,
    [],
    { status: "unknown" },
    { status: "wait", errcode: -1 },
    { status: "confirmed", bot_token: 12 },
    { status: "scaned_but_redirect", redirect_host: {} },
  ])("rejects invalid status response %j", async (body) => {
    await expect(pollLoginStatus("qr", http(body))).rejects.toThrow()
  })
  it("rejects HTTP failures even if their body looks successful", async () => {
    const h: IlinkHttp = async () => ({
      status: 503,
      headers: {},
      body: JSON.stringify({ status: "confirmed", bot_token: "fake" }),
    })
    await expect(pollLoginStatus("qr", h)).rejects.toThrow(/503/)
    await expect(requestLoginQr(h)).rejects.toThrow(/503/)
  })
  it("validates login QR response and returned server URL", async () => {
    await expect(requestLoginQr(http({ qrcode: "qr" }))).rejects.toThrow()
    await expect(
      pollLoginStatus("qr", http({ status: "confirmed", baseurl: "http://127.0.0.1" }))
    ).rejects.toThrow()
  })
  it("allows public HTTPS redirect hosts and rejects URL injection", () => {
    expect(resolveIlinkQrRedirect("ilinkai.weixin.qq.com")).toBe("https://ilinkai.weixin.qq.com")
    for (const host of [
      "127.0.0.1",
      "localhost",
      "evil.example/path",
      "user@evil.example",
      "evil.example?code=x",
      "https://evil.example",
    ])
      expect(() => resolveIlinkQrRedirect(host)).toThrow()
  })
})

it("uses the registered Tauri HTTP bridge by default", async () => {
  ;(connectorsHttpRequest as jest.Mock).mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ qrcode: "qr", qrcode_img_content: "https://weixin.qq.com/login" }),
  })
  expect(await requestLoginQr()).toMatchObject({ qrcode: "qr" })
  expect(connectorsHttpRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "GET",
      url: "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
    })
  )
})
