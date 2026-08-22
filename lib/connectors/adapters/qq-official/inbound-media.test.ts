import { enrichQQInboundMedia, isQQMediaUrl } from "./inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

const CDN = "https://gchat.qpic.cn/qmeetpic/0/1-2-3/0"

function event(segments: MessageSegment[]): NormalizedInboundEvent {
  return {
    platform: "qq-official",
    adapterId: "qq-1",
    selfId: "bot",
    messageId: "m1",
    conversationRef: { platform: "qq-official", adapterId: "qq-1" },
    conversationKey: "qq-official:qq-1:g1",
    sender: { id: "u1", platform: "qq-official", adapterId: "qq-1", remoteUserId: "1" },
    channel: { id: "g1", kind: "group" },
    segments,
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
  }
}

const image = (url = CDN, mimeType = "image/jpeg"): MessageSegment =>
  ({ type: "image", url, mimeType }) as MessageSegment

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

describe("isQQMediaUrl", () => {
  it("accepts QQ's own media hosts", () => {
    expect(isQQMediaUrl(CDN)).toBe(true)
    expect(isQQMediaUrl("https://multimedia.nt.qq.com.cn/download?a=1")).toBe(true)
    expect(isQQMediaUrl("https://p.qlogo.cn/x/0")).toBe(true)
  })

  it("refuses any other host", () => {
    expect(isQQMediaUrl("https://evil.example.com/a.png")).toBe(false)
    // Suffix matching must not be fooled by a lookalike domain.
    expect(isQQMediaUrl("https://qpic.cn.evil.example/a.png")).toBe(false)
    expect(isQQMediaUrl("gchat.qpic.cn/relative")).toBe(false)
    expect(isQQMediaUrl(undefined)).toBe(false)
  })
})

describe("enrichQQInboundMedia", () => {
  it("inlines a picture sent to the bot", async () => {
    const d = deps()
    const e = event([image()])

    await enrichQQInboundMedia(e, d)

    const img = e.segments[0] as { dataBase64?: string; mimeType?: string }
    expect(img.dataBase64).toBe("QUJD")
    // The type QQ reported wins over the generic fallback.
    expect(img.mimeType).toBe("image/jpeg")
  })

  it("keys the cache on the path so a redelivery is a hit", async () => {
    const d = deps()
    await enrichQQInboundMedia(event([image(`${CDN}?rkey=abc`)]), d)
    expect(d._fetch).toHaveBeenCalledWith(
      "qq-1",
      "qq:/qmeetpic/0/1-2-3/0",
      `${CDN}?rkey=abc`,
      undefined
    )
  })

  it("leaves a non-QQ host entirely alone", async () => {
    const d = deps()
    const e = event([image("https://evil.example.com/tracker.png")])

    await enrichQQInboundMedia(e, d)

    expect(d._read).not.toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("extracts text from an attached document", async () => {
    const extractDocText = jest.fn().mockResolvedValue("the plan")
    const d = deps()
    const e = event([
      {
        type: "file",
        url: "https://multimedia.nt.qq.com.cn/plan.pdf",
        name: "plan.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      },
    ])

    await enrichQQInboundMedia(e, { ...d, extractDocText })

    expect((e.segments[0] as { ocrText?: string }).ocrText).toBe("the plan")
  })

  it("makes no call for a text-only message", async () => {
    const d = deps()
    await enrichQQInboundMedia(event([{ type: "text", text: "hi" }]), d)
    expect(d._read).not.toHaveBeenCalled()
  })

  it("never throws when the download fails", async () => {
    const d = deps()
    d._fetch.mockRejectedValue(new Error("403"))
    const e = event([image()])

    await expect(enrichQQInboundMedia(e, d)).resolves.toBeUndefined()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("is inert off-desktop, where the attachment commands do not exist", async () => {
    const d = deps()
    await enrichQQInboundMedia(event([image()]), { ...d, enabled: false })
    expect(d._read).not.toHaveBeenCalled()
  })
})
