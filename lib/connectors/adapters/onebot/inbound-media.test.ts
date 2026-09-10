import { enrichOneBotInboundMedia, isHttpUrl, operatorHostAllowance } from "./inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

const CDN = "https://gchat.qpic.cn/gchatpic_new/1/2/0"

function event(segments: MessageSegment[]): NormalizedInboundEvent {
  return {
    platform: "onebot",
    adapterId: "ob-1",
    selfId: "10001",
    messageId: "77",
    conversationRef: { platform: "onebot", adapterId: "ob-1" },
    conversationKey: "onebot:ob-1:g1",
    sender: { id: "u1", platform: "onebot", adapterId: "ob-1", remoteUserId: "20002" },
    channel: { id: "g1", kind: "group" },
    segments,
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
  }
}

const image = (url = CDN): MessageSegment => ({ type: "image", url })

function deps(bytes: string | null = "QUJD") {
  const fetchAttachment = jest.fn().mockResolvedValue({ cacheKey: "k", remoteRef: "r" })
  const readAttachment = jest.fn().mockResolvedValueOnce(null).mockResolvedValue(bytes)
  return {
    fetchAttachment: fetchAttachment as never,
    readAttachment: readAttachment as never,
    enabled: true,
    _fetch: fetchAttachment,
    _read: readAttachment,
  }
}

describe("isHttpUrl", () => {
  it("accepts absolute http and https", () => {
    expect(isHttpUrl(CDN)).toBe(true)
    expect(isHttpUrl("http://192.168.1.9:3000/file/a.jpg")).toBe(true)
  })

  it("rejects a v12 file_id and a bare filename, which are not downloads", () => {
    expect(isHttpUrl("img-fid")).toBe(false)
    expect(isHttpUrl("ABCDEF.image")).toBe(false)
    expect(isHttpUrl(undefined)).toBe(false)
  })
})

describe("operatorHostAllowance", () => {
  it("is absent in reverse-ws mode, where no address was configured", () => {
    expect(operatorHostAllowance(undefined)).toBeUndefined()
    expect(operatorHostAllowance("not a url")).toBeUndefined()
  })

  it("accepts only the address the operator typed, port included", () => {
    const allow = operatorHostAllowance("ws://192.168.1.9:3001")!
    expect(allow("http://192.168.1.9:3001/file/a.jpg")).toBe(true)
    // Same private range, different machine — an inbound message must not be
    // able to point the app at another host on the network.
    expect(allow("http://192.168.1.50/x.png")).toBe(false)
    expect(allow("http://127.0.0.1/x.png")).toBe(false)
    expect(allow("garbage")).toBe(false)
  })

  it("does not hand the rest of the machine over with the one address", () => {
    // The common config is `ws://127.0.0.1:3001`. Matching on hostname alone
    // would let any inbound message read any other loopback service.
    const allow = operatorHostAllowance("ws://127.0.0.1:3001")!
    expect(allow("http://127.0.0.1:3001/file/a.jpg")).toBe(true)
    expect(allow("http://127.0.0.1:8080/admin/export")).toBe(false)
    expect(allow("http://127.0.0.1/x.png")).toBe(false)
  })

  it("fills in the scheme's default port on both sides", () => {
    const allow = operatorHostAllowance("ws://media.lan")!
    expect(allow("http://media.lan/a.jpg")).toBe(true)
    expect(allow("http://media.lan:80/a.jpg")).toBe(true)
    expect(allow("http://media.lan:8080/a.jpg")).toBe(false)
  })
})

describe("enrichOneBotInboundMedia", () => {
  it("resolves v12 file bytes and document names through get_file before extraction", async () => {
    const send = jest
      .fn()
      .mockResolvedValue({ status: "ok", retcode: 0, data: { data: "SGVsbG8=", name: "note.txt" } })
    const extractDocText = jest.fn().mockResolvedValue("Hello")
    const e = event([
      { type: "file", url: "fid", name: "file", mimeType: "text/plain", sizeBytes: 0 },
    ])
    await enrichOneBotInboundMedia(e, {
      ...deps(),
      transport: { send },
      supportedActions: async () => new Set(["get_file"]),
      extractDocText,
    })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: "get_file", params: { file_id: "fid", type: "data" } })
    )
    expect(e.segments[0]).toMatchObject({ name: "note.txt", ocrText: "Hello", rawUrl: "fid" })
  })

  it("falls back to get_file URL and forwards required download headers", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ status: "failed", retcode: 10004 })
      .mockResolvedValueOnce({
        status: "ok",
        retcode: 0,
        data: { url: CDN, headers: { Authorization: "Bearer media" } },
      })
    const d = deps()
    const e = event([image("fid")])
    await enrichOneBotInboundMedia(e, { ...d, transport: { send } })
    expect(send.mock.calls[1][0].params).toEqual({ file_id: "fid", type: "url" })
    expect(d._fetch).toHaveBeenCalledWith("ob-1", "onebot:/gchatpic_new/1/2/0", CDN, {
      Authorization: "Bearer media",
    })
    expect(e.segments[0]).toMatchObject({ dataBase64: "QUJD", rawUrl: "fid" })
  })

  it("does not call an unsupported get_file action", async () => {
    const send = jest.fn()
    const e = event([image("fid")])
    await enrichOneBotInboundMedia(e, {
      ...deps(),
      transport: { send },
      supportedActions: async () => new Set(),
    })
    expect(send).not.toHaveBeenCalled()
    expect(e.segments[0]).toEqual(image("fid"))
  })

  it("rejects over-limit and malformed inline files independently", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ status: "ok", retcode: 0, data: { data: "SGVsbG8=" } })
      .mockResolvedValueOnce({ status: "ok", retcode: 0, data: { data: "!!!!" } })
      .mockResolvedValueOnce({ status: "ok", retcode: 0, data: { data: "QQ==" } })
    const e = event([image("big"), image("bad"), image("good")])
    await enrichOneBotInboundMedia(e, { ...deps(), maxInlineBytes: 2, transport: { send } })
    expect(e.segments[0]).toEqual(image("big"))
    expect(e.segments[1]).toEqual(image("bad"))
    expect(e.segments[2]).toMatchObject({ dataBase64: "QQ==" })
  })
  it("inlines an image from QQ's CDN", async () => {
    const d = deps()
    const e = event([image()])

    await enrichOneBotInboundMedia(e, d)

    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBe("QUJD")
    expect(d._fetch).toHaveBeenCalledWith("ob-1", "onebot:/gchatpic_new/1/2/0", CDN, undefined)
  })

  it("downloads from the implementation's own LAN file server when configured", async () => {
    // NapCat / Lagrange routinely rewrite media URLs to their own HTTP server.
    const d = deps()
    const e = event([image("http://192.168.1.9:3001/file/a.jpg")])

    await enrichOneBotInboundMedia(e, { ...d, forwardWsUrl: "ws://192.168.1.9:3001/onebot" })

    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBe("QUJD")
  })

  it("refuses a private host in reverse-ws mode, where none was configured", async () => {
    const d = deps()
    const e = event([image("http://192.168.1.9:3000/file/a.jpg")])

    await enrichOneBotInboundMedia(e, d)

    expect(d._fetch).not.toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("refuses a private host that is not the configured one", async () => {
    const d = deps()
    const e = event([image("http://169.254.169.254/latest/meta-data/")])

    await enrichOneBotInboundMedia(e, { ...d, forwardWsUrl: "ws://192.168.1.9:3001" })

    expect(d._fetch).not.toHaveBeenCalled()
  })

  it("leaves a v12 file_id segment as its marker", async () => {
    const d = deps()
    const e = event([image("img-fid")])

    await enrichOneBotInboundMedia(e, d)

    expect(d._read).not.toHaveBeenCalled()
    expect(e.segments[0]).toMatchObject({ type: "image", url: "img-fid" })
  })

  it("makes no call for a text-only message", async () => {
    const d = deps()
    await enrichOneBotInboundMedia(event([{ type: "text", text: "hi" }]), d)
    expect(d._read).not.toHaveBeenCalled()
  })

  it("never throws when the download fails", async () => {
    const d = deps()
    d._fetch.mockRejectedValue(new Error("connection refused"))
    const e = event([image()])

    await expect(enrichOneBotInboundMedia(e, d)).resolves.toBeUndefined()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("is inert off-desktop, where the attachment commands do not exist", async () => {
    const d = deps()
    await enrichOneBotInboundMedia(event([image()]), { ...d, enabled: false })
    expect(d._read).not.toHaveBeenCalled()
  })
})
