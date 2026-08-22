import {
  enrichTelegramInboundMedia,
  fileIdFromUrl,
  mimeFromFilePath,
  TELEGRAM_FILE_SCHEME,
} from "./inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

function event(segments: MessageSegment[]): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "tg-1",
    selfId: "bot",
    messageId: "10",
    conversationRef: { platform: "telegram", adapterId: "tg-1" },
    conversationKey: "telegram:tg-1:42",
    sender: { id: "u1", platform: "telegram", adapterId: "tg-1", remoteUserId: "1" },
    channel: { id: "42", kind: "group" },
    segments,
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
  }
}

const photo = (fileId = "AgACfoo"): MessageSegment => ({
  type: "image",
  url: `${TELEGRAM_FILE_SCHEME}${fileId}`,
})

const doc = (name: string, fileId = "BQACbar"): MessageSegment => ({
  type: "file",
  url: `${TELEGRAM_FILE_SCHEME}${fileId}`,
  name,
  mimeType: "application/pdf",
  sizeBytes: 10,
})

function deps(overrides: Partial<Parameters<typeof enrichTelegramInboundMedia>[1]> = {}) {
  const httpRequest = jest.fn().mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg" } }),
  })
  const fetchAttachment = jest.fn().mockResolvedValue({ localUrl: "x", remoteRef: "y" })
  const readAttachment = jest.fn().mockResolvedValue(null)
  return {
    httpRequest,
    fetchAttachment,
    readAttachment,
    botToken: jest.fn().mockResolvedValue("TOKEN"),
    enabled: true,
    ...overrides,
  } as Parameters<typeof enrichTelegramInboundMedia>[1] & {
    httpRequest: jest.Mock
    fetchAttachment: jest.Mock
    readAttachment: jest.Mock
    botToken: jest.Mock
  }
}

describe("fileIdFromUrl", () => {
  it("extracts the id from the parser's pseudo-URL", () => {
    expect(fileIdFromUrl("tg://file/ABC")).toBe("ABC")
  })

  it("ignores anything that is not one", () => {
    expect(fileIdFromUrl("https://example.com/a.png")).toBeUndefined()
    expect(fileIdFromUrl("tg://file/")).toBeUndefined()
    expect(fileIdFromUrl(undefined)).toBeUndefined()
  })
})

describe("mimeFromFilePath", () => {
  it("reads the real extension Telegram returns", () => {
    expect(mimeFromFilePath("photos/file_1.jpg")).toBe("image/jpeg")
    expect(mimeFromFilePath("photos/file_1.png")).toBe("image/png")
    expect(mimeFromFilePath("a/b.webp")).toBe("image/webp")
  })

  it("is undefined for anything it cannot name", () => {
    expect(mimeFromFilePath("documents/file_2.bin")).toBeUndefined()
    expect(mimeFromFilePath(undefined)).toBeUndefined()
  })
})

describe("enrichTelegramInboundMedia", () => {
  it("downloads a photo and inlines it so the model sees the picture", async () => {
    const d = deps()
    d.readAttachment.mockResolvedValueOnce(null).mockResolvedValueOnce("BASE64BYTES")
    const e = event([photo()])

    await enrichTelegramInboundMedia(e, d)

    const img = e.segments[0] as { dataBase64?: string; mimeType?: string }
    expect(img.dataBase64).toBe("BASE64BYTES")
    // JPEG, from the real file_path — not the PNG the model path defaults to.
    expect(img.mimeType).toBe("image/jpeg")
  })

  it("keys the cache on the stable file_id, not the expiring path", async () => {
    const d = deps()
    d.readAttachment.mockResolvedValueOnce(null).mockResolvedValueOnce("B64")
    await enrichTelegramInboundMedia(event([photo("STABLE")]), d)

    expect(d.fetchAttachment).toHaveBeenCalledWith(
      "tg-1",
      "telegram:STABLE",
      "https://api.telegram.org/file/botTOKEN/photos/file_1.jpg"
    )
  })

  it("skips getFile entirely on a cache hit", async () => {
    // The path Telegram returns expires in about an hour; the id does not, so
    // a redelivery must not need a fresh getFile.
    const d = deps()
    d.readAttachment.mockResolvedValue("CACHED")
    const e = event([photo()])

    await enrichTelegramInboundMedia(e, d)

    expect(d.httpRequest).not.toHaveBeenCalled()
    expect(d.fetchAttachment).not.toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBe("CACHED")
  })

  it("makes no call at all for a text-only message", async () => {
    const d = deps()
    await enrichTelegramInboundMedia(event([{ type: "text", text: "hi" }]), d)
    expect(d.botToken).not.toHaveBeenCalled()
    expect(d.httpRequest).not.toHaveBeenCalled()
  })

  it("leaves the marker intact when getFile refuses", async () => {
    const d = deps()
    d.httpRequest.mockResolvedValue({ status: 400, headers: {}, body: "{}" })
    const e = event([photo()])

    await enrichTelegramInboundMedia(e, d)

    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
    expect(e.segments[0]).toMatchObject({ url: "tg://file/AgACfoo" })
    expect(d.fetchAttachment).not.toHaveBeenCalled()
  })

  it("leaves the marker intact when Telegram answers ok:false", async () => {
    const d = deps()
    d.httpRequest.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, description: "file is too big" }),
    })
    const e = event([photo()])

    await enrichTelegramInboundMedia(e, d)
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("does nothing without a token rather than throwing", async () => {
    const d = deps({ botToken: jest.fn().mockRejectedValue(new Error("locked")) })
    const e = event([photo()])

    await expect(enrichTelegramInboundMedia(e, d)).resolves.toBeUndefined()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("one unreadable attachment does not cost the others", async () => {
    const d = deps()
    d.httpRequest
      .mockResolvedValueOnce({ status: 500, headers: {}, body: "" })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, result: { file_path: "photos/b.png" } }),
      })
    d.readAttachment
      .mockResolvedValueOnce(null) // first: cache miss
      .mockResolvedValueOnce(null) // second: cache miss
      .mockResolvedValueOnce("SECOND")
    const e = event([photo("first"), photo("second")])

    await enrichTelegramInboundMedia(e, d)

    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
    expect((e.segments[1] as { dataBase64?: string }).dataBase64).toBe("SECOND")
  })

  it("never re-downloads a segment that already carries bytes", async () => {
    const d = deps()
    d.readAttachment.mockResolvedValue("CACHED")
    const e = event([
      { type: "image", url: "tg://file/x", dataBase64: "ALREADY" } as MessageSegment,
    ])

    await enrichTelegramInboundMedia(e, d)

    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBe("ALREADY")
  })

  it("extracts text from a document so the model reads its contents", async () => {
    const extractDocText = jest.fn().mockResolvedValue("the report says yes")
    const d = deps({ extractDocText })
    d.readAttachment.mockResolvedValue("QUJD") // base64 "ABC"
    const e = event([doc("report.pdf")])

    await enrichTelegramInboundMedia(e, d)

    expect(extractDocText).toHaveBeenCalled()
    expect((e.segments[0] as { ocrText?: string }).ocrText).toBe("the report says yes")
  })

  it("does not run the extractor on a file type it cannot read", async () => {
    const extractDocText = jest.fn()
    const d = deps({ extractDocText })
    d.readAttachment.mockResolvedValue("QUJD")

    await enrichTelegramInboundMedia(event([doc("clip.mp4")]), d)

    expect(extractDocText).not.toHaveBeenCalled()
  })

  it("is inert off-desktop, where the attachment commands do not exist", async () => {
    const d = deps({ enabled: false })
    await enrichTelegramInboundMedia(event([photo()]), d)
    expect(d.botToken).not.toHaveBeenCalled()
  })
})
