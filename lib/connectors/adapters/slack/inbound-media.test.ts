import { enrichSlackInboundMedia, isSlackFileUrl } from "./inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

const PRIVATE = "https://files.slack.com/files-pri/T1-F2/screenshot.png"

function event(segments: MessageSegment[]): NormalizedInboundEvent {
  return {
    platform: "slack",
    adapterId: "sl-1",
    selfId: "U0BOT",
    messageId: "1700000000.000100",
    conversationRef: { platform: "slack", adapterId: "sl-1" },
    conversationKey: "slack:sl-1:C1",
    sender: { id: "u1", platform: "slack", adapterId: "sl-1", remoteUserId: "U1" },
    channel: { id: "C1", kind: "group" },
    segments,
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
  }
}

const image = (url = PRIVATE, mimeType?: string): MessageSegment =>
  ({ type: "image", url, ...(mimeType ? { mimeType } : {}) }) as MessageSegment

function deps(bytes: string | null = "QUJD") {
  const fetchAttachment = jest.fn().mockResolvedValue({ cacheKey: "k", remoteRef: "r" })
  const readAttachment = jest.fn().mockResolvedValueOnce(null).mockResolvedValue(bytes)
  const botToken = jest.fn().mockResolvedValue("xoxb-1")
  return {
    botToken,
    fetchAttachment: fetchAttachment as never,
    readAttachment: readAttachment as never,
    enabled: true,
    _fetch: fetchAttachment,
    _read: readAttachment,
  }
}

describe("isSlackFileUrl", () => {
  it("accepts Slack's private file host", () => {
    expect(isSlackFileUrl(PRIVATE)).toBe(true)
  })

  it("refuses any other host, so the bot token is never sent off-workspace", () => {
    expect(isSlackFileUrl("https://evil.example.com/a.png")).toBe(false)
    expect(isSlackFileUrl("https://files.slack.com.evil.example/a.png")).toBe(false)
    expect(isSlackFileUrl("files.slack.com/relative")).toBe(false)
    expect(isSlackFileUrl(undefined)).toBe(false)
  })
})

describe("enrichSlackInboundMedia", () => {
  it("inlines a shared screenshot so the model sees the picture", async () => {
    const d = deps()
    const e = event([image(PRIVATE, "image/png")])

    await enrichSlackInboundMedia(e, d)

    const img = e.segments[0] as { dataBase64?: string; mimeType?: string }
    expect(img.dataBase64).toBe("QUJD")
    expect(img.mimeType).toBe("image/png")
  })

  it("sends the bot token, without which url_private answers a login page", async () => {
    const d = deps()
    await enrichSlackInboundMedia(event([image()]), d)

    expect(d._fetch).toHaveBeenCalledWith(
      "sl-1",
      "slack:/files-pri/T1-F2/screenshot.png",
      PRIVATE,
      {
        Authorization: "Bearer xoxb-1",
      }
    )
  })

  it("resolves the token once for a multi-file post", async () => {
    const d = deps()
    d._read.mockReset().mockResolvedValue(null) // every read misses → both resolve
    await enrichSlackInboundMedia(
      event([image("https://files.slack.com/files-pri/T1-F2/a.png"), image()]),
      d
    )
    expect(d.botToken).toHaveBeenCalledTimes(1)
    expect(d._fetch).toHaveBeenCalledTimes(2)
  })

  it("resolves no token at all on a cache hit", async () => {
    const d = deps()
    d._read.mockReset().mockResolvedValue("CACHED")

    await enrichSlackInboundMedia(event([image()]), d)

    expect(d.botToken).not.toHaveBeenCalled()
    expect(d._fetch).not.toHaveBeenCalled()
  })

  it("leaves a non-Slack URL entirely alone", async () => {
    const d = deps()
    const e = event([image("https://evil.example.com/tracker.png")])

    await enrichSlackInboundMedia(e, d)

    expect(d._read).not.toHaveBeenCalled()
    expect(d.botToken).not.toHaveBeenCalled()
  })

  it("extracts text from a shared document", async () => {
    const extractDocText = jest.fn().mockResolvedValue("quarterly numbers")
    const d = deps()
    const e = event([
      {
        type: "file",
        url: "https://files.slack.com/files-pri/T1-F3/q3.pdf",
        name: "q3.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      },
    ])

    await enrichSlackInboundMedia(e, { ...d, extractDocText })

    expect((e.segments[0] as { ocrText?: string }).ocrText).toBe("quarterly numbers")
  })

  it("makes no call for a text-only message", async () => {
    const d = deps()
    await enrichSlackInboundMedia(event([{ type: "text", text: "hi" }]), d)
    expect(d._read).not.toHaveBeenCalled()
    expect(d.botToken).not.toHaveBeenCalled()
  })

  it("leaves the marker intact when the token cannot be resolved", async () => {
    const d = deps()
    d.botToken.mockRejectedValue(new Error("keyring locked"))
    const e = event([image()])

    await expect(enrichSlackInboundMedia(e, d)).resolves.toBeUndefined()
    expect(d._fetch).not.toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("is inert off-desktop, where the attachment commands do not exist", async () => {
    const d = deps()
    await enrichSlackInboundMedia(event([image()]), { ...d, enabled: false })
    expect(d._read).not.toHaveBeenCalled()
    expect(d.botToken).not.toHaveBeenCalled()
  })
})
