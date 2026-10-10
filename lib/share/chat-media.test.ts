jest.mock("@/lib/db/message-media", () => ({
  ...jest.requireActual("@/lib/db/message-media"),
  getMessageMedia: jest.fn(),
}))

import type { StoredMessage } from "@cognia/agent-config-types"
import type { MessageMediaRow } from "@/lib/db/message-media"

import {
  SHARE_ATTACHMENTS_PREFIX,
  SHARE_INLINE_IMAGE_MAX_BYTES,
  SHARE_INLINE_MEDIA_BUDGET_BYTES,
  materializeChatShareMedia,
  type ChatShareMediaDeps,
} from "./chat-media"

function row(hash: string, size: number, mediaType = "image/png"): MessageMediaRow {
  return {
    hash,
    mediaType,
    width: 1,
    height: 1,
    blob: new Blob([new Uint8Array(size).fill(7)], { type: mediaType }),
    byteSize: size,
    createdAt: 0,
    lastUsedAt: 0,
  }
}

function message(id: string, parts: unknown[]): StoredMessage {
  return { id, sessionId: "s", role: "user", parts, createdAt: 0 } as unknown as StoredMessage
}

function deps(rows: MessageMediaRow[]): ChatShareMediaDeps & { getMessageMedia: jest.Mock } {
  const byHash = new Map(rows.map((r) => [r.hash, r]))
  return { getMessageMedia: jest.fn(async (hash: string) => byHash.get(hash)) }
}

const text = { type: "text", text: "hello" }

describe("materializeChatShareMedia", () => {
  it("inlines a small image and leaves other parts and messages untouched", async () => {
    const plain = message("m0", [text])
    const withImage = message("m1", [
      text,
      { type: "file", url: "cognia-media:aaaa", mediaType: "image/png", filename: "a.png" },
      { type: "file", url: "https://example.com/x.png", mediaType: "image/png" },
    ])
    const result = await materializeChatShareMedia([plain, withImage], deps([row("aaaa", 4)]))
    expect(result.messages[0]).toBe(plain)
    const parts = result.messages[1].parts as Array<{ url?: string }>
    expect(parts[1].url).toBe("data:image/png;base64,BwcHBw==")
    expect(parts[2].url).toBe("https://example.com/x.png")
    expect(result.attachments).toEqual([])
    expect(result.unavailable).toBe(0)
  })

  it("carries an image over the per-image cap as a share file named in the transcript", async () => {
    const big = row("bbbbbbbbbb", SHARE_INLINE_IMAGE_MAX_BYTES + 1)
    const result = await materializeChatShareMedia(
      [message("m", [{ type: "file", url: "cognia-media:bbbbbbbbbb", mediaType: "image/png" }])],
      deps([big])
    )
    expect(result.attachments).toHaveLength(1)
    const [attachment] = result.attachments
    expect(attachment).toMatchObject({
      path: `${SHARE_ATTACHMENTS_PREFIX}/image-bbbbbbbb.png`,
      name: "image-bbbbbbbb.png",
      mime: "image/png",
    })
    expect((await attachment.open()).size).toBe(big.blob.size)
    const part = result.messages[0].parts[0] as { url: string; filename: string }
    expect(part).toMatchObject({ url: "", filename: "image-bbbbbbbb.png" })
  })

  it("stops inlining once the share's budget is spent and dedupes repeats", async () => {
    const size = SHARE_INLINE_IMAGE_MAX_BYTES
    const count = Math.floor(SHARE_INLINE_MEDIA_BUDGET_BYTES / size) + 1
    const rows = Array.from({ length: count }, (_, i) => row(`h${i}`, size))
    const parts = rows.map((r) => ({
      type: "file",
      url: `cognia-media:${r.hash}`,
      mediaType: "image/png",
      filename: "same.png",
    }))
    const d = deps(rows)
    const result = await materializeChatShareMedia(
      [message("m1", parts), message("m2", [parts[0]])],
      d
    )
    const urls = (result.messages[0].parts as Array<{ url: string }>).map((p) => p.url)
    expect(urls.filter((url) => url.startsWith("data:"))).toHaveLength(count - 1)
    expect(result.attachments.map((a) => a.name)).toEqual(["same.png"])
    // The repeat in the second message reuses the first resolution.
    expect((result.messages[1].parts[0] as { url: string }).url).toBe(urls[0])
    expect(d.getMessageMedia).toHaveBeenCalledTimes(count)
  })

  it("names colliding attachments apart and keeps non-images out of the transcript", async () => {
    const result = await materializeChatShareMedia(
      [
        message("m", [
          {
            type: "file",
            url: "cognia-media:p1",
            mediaType: "application/pdf",
            filename: "doc.pdf",
          },
          {
            type: "file",
            url: "cognia-media:p2",
            mediaType: "application/pdf",
            filename: "doc.pdf",
          },
        ]),
      ],
      deps([row("p1", 10, "application/pdf"), row("p2", 10, "application/pdf")])
    )
    expect(result.attachments.map((a) => a.name)).toEqual(["doc.pdf", "doc (2).pdf"])
  })

  it("names media whose bytes are gone without a link and counts it", async () => {
    const result = await materializeChatShareMedia(
      [
        message("m", [
          { type: "file", url: "cognia-media:gone", mediaType: "image/png", filename: "g.png" },
          { type: "image", url: "cognia-media:thumb", mediaType: "image/png" },
        ]),
      ],
      deps([{ ...row("thumb", 4), canonicalAvailable: false }])
    )
    expect(result.unavailable).toBe(2)
    expect((result.messages[0].parts as Array<{ url: string }>).map((p) => p.url)).toEqual(["", ""])
    expect(result.attachments).toEqual([])
  })
})
