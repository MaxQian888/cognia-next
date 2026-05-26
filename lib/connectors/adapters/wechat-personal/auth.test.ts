import { requestLoginQr, pollLoginStatus, type IlinkHttp } from "./auth"

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
