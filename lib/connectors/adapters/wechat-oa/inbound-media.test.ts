import { enrichWechatInboundMedia } from "./inbound-media"
import { parseWechatOaXml } from "./parse"
import { invoke } from "@tauri-apps/api/core"

const event = (type: string) =>
  parseWechatOaXml(
    "oa",
    "self",
    `<xml><FromUserName>user</FromUserName><CreateTime>1</CreateTime><MsgType>${type}</MsgType><MediaId>media1</MediaId><MsgId>1</MsgId></xml>`
  )!
const deps = () => ({
  enabled: true,
  accessToken: jest.fn(async () => "secret"),
  apiBase: "https://api.weixin.qq.com",
  fetchAttachment: jest.fn(async () => ({ sizeBytes: 3 })) as jest.Mock,
  readAttachment: jest.fn().mockResolvedValueOnce(null).mockResolvedValue("/9j/"),
  httpRequest: jest.fn(async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ video_url: "https://cdn.example/video.mp4" }),
  })),
})

it("resolves image MediaId through authenticated download and encrypted cache", async () => {
  const e = event("image")
  const d = deps()
  await enrichWechatInboundMedia(e, d)
  expect(d.fetchAttachment).toHaveBeenCalledWith(
    "oa",
    "wechat-oa:media:media1",
    expect.stringContaining("media_id=media1"),
    undefined
  )
  expect(e.segments[0]).toMatchObject({ dataBase64: "/9j/", mimeType: "image/jpeg" })
})

it.each(["voice", "video"])(
  "resolves %s to usable bytes while retaining platform reference",
  async (type) => {
    const e = event(type)
    const d = deps()
    await enrichWechatInboundMedia(e, d)
    expect(e.segments[0]).toMatchObject({
      rawUrl: "wxmedia://media1",
      url: expect.stringMatching(/^data:/),
    })
    if (type === "video")
      expect(d.fetchAttachment).toHaveBeenCalledWith(
        "oa",
        "wechat-oa:media:media1",
        "https://cdn.example/video.mp4"
      )
  }
)

it("does not resolve credentials for cache hits", async () => {
  const e = event("voice")
  const d = deps()
  d.readAttachment.mockReset().mockResolvedValue("cached")
  await enrichWechatInboundMedia(e, d)
  expect(d.accessToken).not.toHaveBeenCalled()
  expect(d.fetchAttachment).not.toHaveBeenCalled()
})

it("rejects private video redirects and retains original marker on failures", async () => {
  const e = event("video")
  const d = deps()
  d.httpRequest.mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ video_url: "http://127.0.0.1/private" }),
  })
  await enrichWechatInboundMedia(e, d)
  expect(d.fetchAttachment).not.toHaveBeenCalled()
  expect(e.segments[0]).toMatchObject({ url: "wxmedia://media1" })
  d.httpRequest.mockRejectedValue(new Error("offline"))
  await expect(enrichWechatInboundMedia(e, d)).resolves.toBeUndefined()
})

it("stays inert outside supported hosts and ignores text", async () => {
  const d = deps()
  await enrichWechatInboundMedia(event("image"), { ...d, enabled: false })
  await enrichWechatInboundMedia(event("text"), d)
  expect(d.accessToken).not.toHaveBeenCalled()
})

it.each([
  [500, {}],
  [200, { errcode: 40007 }],
  [200, {}],
])("keeps video markers on an invalid download response", async (status, body) => {
  const e = event("video")
  const d = deps()
  d.httpRequest.mockResolvedValue({ status, headers: {}, body: JSON.stringify(body) })
  await enrichWechatInboundMedia(e, d)
  expect(d.fetchAttachment).not.toHaveBeenCalled()
  expect(e.segments[0]).toMatchObject({ url: "wxmedia://media1" })
})

it("does not attach bytes after failed or oversized cache reads", async () => {
  const e = event("voice")
  const d = deps()
  d.readAttachment.mockReset().mockResolvedValue(null)
  await enrichWechatInboundMedia(e, d)
  expect(e.segments[0]).toMatchObject({ url: "wxmedia://media1" })
})

it("ignores missing platform references and accepts preserved raw references", async () => {
  const e = event("voice")
  const d = deps()
  e.segments = [
    { type: "voice", url: "https://example.com/v" },
    { type: "image", url: "https://example.com/i" },
  ]
  await enrichWechatInboundMedia(e, d)
  expect(d.accessToken).not.toHaveBeenCalled()
  e.segments = [{ type: "voice", url: "data:audio/amr;base64,old", rawUrl: "wxmedia://media1" }]
  await enrichWechatInboundMedia(e, d)
  expect(e.segments[0]).toMatchObject({
    rawUrl: "wxmedia://media1",
    url: "data:audio/amr;base64,/9j/",
  })
})

it("uses the production attachment command defaults", async () => {
  let reads = 0
  const mockInvoke = invoke as jest.Mock
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "connectors_attachment_read") return ++reads === 1 ? null : "/9j/"
    if (cmd === "connectors_attachment_fetch") return { sizeBytes: 3 }
    if (cmd === "connectors_http_request")
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ video_url: "https://cdn.example/v" }),
      }
  })
  const e = event("video")
  await enrichWechatInboundMedia(e, {
    enabled: true,
    accessToken: async () => "token",
    apiBase: "https://api.weixin.qq.com",
  })
  expect(e.segments[0]).toMatchObject({ url: "data:video/mp4;base64,/9j/" })
  mockInvoke.mockReset()
})
