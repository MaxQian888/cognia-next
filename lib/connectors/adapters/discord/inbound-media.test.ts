import { enrichDiscordInboundMedia, isDiscordCdnUrl } from "./inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

const CDN = "https://cdn.discordapp.com/attachments/100/200/shot.png"

function event(segments: MessageSegment[]): NormalizedInboundEvent {
  return {
    platform: "discord",
    adapterId: "dc-1",
    selfId: "bot",
    messageId: "9",
    conversationRef: { platform: "discord", adapterId: "dc-1" },
    conversationKey: "discord:dc-1:c1",
    sender: { id: "u1", platform: "discord", adapterId: "dc-1", remoteUserId: "1" },
    channel: { id: "c1", kind: "group" },
    segments,
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
  }
}

const image = (url = `${CDN}?ex=abc&is=def&hm=cafe`, mimeType?: string): MessageSegment =>
  ({ type: "image", url, ...(mimeType ? { mimeType } : {}) }) as MessageSegment

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

describe("isDiscordCdnUrl", () => {
  it("accepts Discord's own attachment hosts", () => {
    expect(isDiscordCdnUrl(CDN)).toBe(true)
    expect(isDiscordCdnUrl("https://media.discordapp.net/attachments/1/2/a.gif")).toBe(true)
  })

  it("refuses any other host an inbound message might name", () => {
    // An embed or a pasted link must not turn the bot into a fetcher for
    // whatever host a stranger puts in a message.
    expect(isDiscordCdnUrl("https://evil.example.com/a.png")).toBe(false)
    expect(isDiscordCdnUrl("https://cdn.discordapp.com.evil.example/a.png")).toBe(false)
    expect(isDiscordCdnUrl("not a url")).toBe(false)
    expect(isDiscordCdnUrl(undefined)).toBe(false)
  })
})

describe("enrichDiscordInboundMedia", () => {
  it("inlines a posted screenshot so the model sees the picture", async () => {
    const d = deps()
    const e = event([image(`${CDN}?ex=abc`, "image/png")])

    await enrichDiscordInboundMedia(e, d)

    const img = e.segments[0] as { dataBase64?: string; mimeType?: string }
    expect(img.dataBase64).toBe("QUJD")
    expect(img.mimeType).toBe("image/png")
  })

  it("keys the cache on the path, because Discord re-signs the query", async () => {
    const d = deps()
    await enrichDiscordInboundMedia(event([image(`${CDN}?ex=1&is=2&hm=deadbeef`)]), d)

    expect(d._fetch).toHaveBeenCalledWith(
      "dc-1",
      "discord:/attachments/100/200/shot.png",
      `${CDN}?ex=1&is=2&hm=deadbeef`,
      // The signature IS the authorisation — sending a bot token here would
      // leak it to the CDN.
      undefined
    )
  })

  it("re-downloading the same file after a re-sign is a cache hit", async () => {
    const d = deps()
    d._read.mockReset().mockResolvedValue("CACHED")

    await enrichDiscordInboundMedia(event([image(`${CDN}?ex=9&hm=fresh`)]), d)

    expect(d._fetch).not.toHaveBeenCalled()
    expect(d._read).toHaveBeenCalledWith("dc-1", "discord:/attachments/100/200/shot.png", 5242880)
  })

  it("leaves a non-Discord URL entirely alone", async () => {
    const d = deps()
    const e = event([image("https://evil.example.com/tracker.png")])

    await enrichDiscordInboundMedia(e, d)

    expect(d._read).not.toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("extracts text from a posted document", async () => {
    const extractDocText = jest.fn().mockResolvedValue("quarterly numbers")
    const d = deps()
    const e = event([
      {
        type: "file",
        url: `${CDN.replace("shot.png", "q3.pdf")}?ex=1`,
        name: "q3.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      },
    ])

    await enrichDiscordInboundMedia(e, { ...d, extractDocText })

    expect((e.segments[0] as { ocrText?: string }).ocrText).toBe("quarterly numbers")
  })

  it("makes no call for a text-only message", async () => {
    const d = deps()
    await enrichDiscordInboundMedia(event([{ type: "text", text: "hi" }]), d)
    expect(d._read).not.toHaveBeenCalled()
  })

  it("never throws when the download fails", async () => {
    const d = deps()
    d._fetch.mockRejectedValue(new Error("410 gone"))
    const e = event([image()])

    await expect(enrichDiscordInboundMedia(e, d)).resolves.toBeUndefined()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("is inert off-desktop, where the attachment commands do not exist", async () => {
    const d = deps()
    await enrichDiscordInboundMedia(event([image()]), { ...d, enabled: false })
    expect(d._read).not.toHaveBeenCalled()
  })
})
