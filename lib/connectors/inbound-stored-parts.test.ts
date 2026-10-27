import {
  inboundEventFromStoredMessage,
  inboundEventToStoredParts,
  inboundPartsForReplay,
  mergeInboundMessagesForStream,
  stripInboundDisplayMarkers,
} from "./inbound-stored-parts"
import type { UIMessage } from "ai"

describe("mergeInboundMessagesForStream", () => {
  const message = (id: string, createdAt?: number, inbound = false): UIMessage => ({
    id,
    role: inbound ? "user" : "assistant",
    parts: [{ type: "text", text: id }],
    metadata: {
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(inbound ? { platformMessage: { messageId: id, platform: "onebot" } } : {}),
    },
  })

  it("inserts committed inbound rows by time without reordering the existing stream", () => {
    const first = message("first", 10)
    const boundary = message("boundary")
    const assistant = message("answer", 30)
    const stream = [first, boundary, assistant]
    const inbound = message("inbound", 20, true)
    const later = message("later", 40, true)
    expect(mergeInboundMessagesForStream(stream, [later, inbound])).toEqual([
      first,
      boundary,
      inbound,
      assistant,
      later,
    ])
    expect(stream).toEqual([first, boundary, assistant])
  })

  it("uses the current transport revision once while retaining the streamed assistant", () => {
    const stale = message("inbound", 10, true)
    const assistant = message("answer", 20)
    const recalled = {
      ...stale,
      parts: [{ type: "text" as const, text: "[deleted]" }],
      metadata: { ...stale.metadata!, deletedAt: 30 },
    }
    const merged = mergeInboundMessagesForStream([stale, assistant], [recalled, assistant])
    expect(merged).toEqual([recalled, assistant])
    expect(merged[0]).toBe(recalled)
    expect(merged[1]).toBe(assistant)
    expect(mergeInboundMessagesForStream(merged, [recalled])).toBe(merged)
  })

  it("does not restore omitted ordinary rows or malformed connector provenance", () => {
    const stream = [message("answer", 20)]
    expect(
      mergeInboundMessagesForStream(stream, [
        message("ordinary", 10),
        { ...message("malformed", 10), metadata: { platformMessage: null } },
      ])
    ).toBe(stream)
  })

  it("keeps untimed inbound rows stable and does not duplicate repeated projected ids", () => {
    const assistant = message("answer", 20)
    const inbound = message("untimed", undefined, true)
    expect(mergeInboundMessagesForStream([assistant], [inbound, inbound])).toEqual([
      assistant,
      inbound,
    ])
  })
})

describe("inboundEventToStoredParts", () => {
  it("replays canonical text without media bytes while retaining explicit safe continuation intent", () => {
    const event = {
      plainText: "continue at a safe boundary",
      segments: [{ type: "image", url: "data:image/png;base64,OLD", dataBase64: "OLD" }],
      raw: { bytes: "OLD" },
      channelData: { recoveryIntent: "continue_safely" },
      mediaModelPolicy: "allow_cloud_binary",
    } as never
    const row = {
      parts: [
        { type: "text", text: "latest canonical" },
        { type: "file", url: "data:image/png;base64,OLD", mediaType: "image/png" },
      ],
    } as never
    const replay = inboundEventFromStoredMessage(
      { ...(event as object), channelData: {} } as never,
      row
    )
    expect(replay.plainText).toContain("latest canonical")
    expect(replay.mediaModelPolicy).toBe("local_extract_only")
    expect(JSON.stringify(replay)).not.toContain("OLD")
    expect(inboundEventFromStoredMessage(event, row).plainText).toBe("continue at a safe boundary")
  })
  it("isolates malformed fresh segments while preserving valid siblings and safe fallback", () => {
    expect(
      inboundEventToStoredParts({
        plainText: "fallback",
        segments: [
          null,
          { type: "text", text: 42 },
          { type: "text", text: "caption" },
          { type: "image", url: "key" },
        ] as never,
      })
    ).toEqual([
      { type: "text", text: "caption" },
      { type: "text", text: "[image: key]" },
    ])
    expect(inboundEventToStoredParts({ plainText: "fallback", segments: {} as never })).toEqual([
      { type: "text", text: "fallback" },
    ])
  })
  it("drops malformed historical siblings and withholds legacy binary parts", () => {
    const parts = [
      { type: "text", text: "caption" },
      null,
      { type: "text", text: 42 },
      { type: "file", url: "data:image/png;base64,DISPLAY_ONLY", mediaType: "image/png" },
      {
        type: "file",
        url: "data:application/pdf;base64,DISPLAY_ONLY",
        mediaType: "application/pdf",
        filename: "report.pdf",
      },
      { type: "image", source: { type: "base64", data: "DISPLAY_ONLY" } },
    ]
    expect(inboundPartsForReplay(parts as never)).toEqual([
      { type: "text", text: "caption" },
      { type: "text", text: "[image]" },
      { type: "text", text: "[file: report.pdf]" },
      { type: "text", text: "[image]" },
    ])
    expect(inboundPartsForReplay(null as never)).toEqual([])
  })
  it("preserves repeated source text and media occurrences in history", () => {
    expect(
      inboundEventToStoredParts({
        plainText: "yesyes [image] [image]",
        segments: [
          { type: "text", text: "yes" },
          { type: "text", text: "yes" },
          { type: "image", url: "key" },
          { type: "image", url: "key" },
        ],
      })
    ).toEqual([
      { type: "text", text: "yes" },
      { type: "text", text: "yes" },
      { type: "text", text: "[image: key]" },
      { type: "text", text: "[image: key]" },
    ])
  })

  it("projects each non-text segment once instead of repeating the full message", () => {
    expect(
      inboundEventToStoredParts({
        plainText: "[reply:quoted] hello spoken [video]",
        segments: [
          { type: "reply", messageId: "parent", snippet: "quoted" },
          { type: "text", text: "hello" },
          { type: "voice", url: "data:audio/ogg;base64,DISPLAY_ONLY", transcript: "spoken" },
          { type: "video", url: "data:video/mp4;base64,DISPLAY_ONLY" },
        ],
      })
    ).toEqual([
      { type: "text", text: "[reply:quoted]" },
      { type: "text", text: "hello" },
      { type: "text", text: "spoken" },
      { type: "text", text: "[video]" },
    ])
  })
  it.each(["data:image/png;base64,DISPLAY", "blob:DISPLAY"])(
    "scrubs embedded and clipped %s markers while preserving surrounding text",
    (url) => {
      expect(stripInboundDisplayMarkers(`before [image: ${url}] after`)).toBe(
        "before [image] after"
      )
      expect(stripInboundDisplayMarkers(`before [image: ${url}`)).toBe("before [image]")
      expect(stripInboundDisplayMarkers("[image: https://example.com/a.png]")).toBe(
        "[image: https://example.com/a.png]"
      )
    }
  )
  it("removes historical inline data markers without changing other text or the input", () => {
    const parts = [
      { type: "text" as const, text: "[image: data:image/png;base64,DISPLAY_ONLY]" },
      { type: "text" as const, text: "words" },
    ]
    expect(inboundPartsForReplay(parts)).toEqual([
      { type: "text", text: "[image]" },
      { type: "text", text: "words" },
    ])
    expect(parts[0].text).toContain("DISPLAY_ONLY")
  })
  it("keeps resolved data URLs out of replayed text markers", () => {
    expect(
      inboundEventToStoredParts({
        plainText: "[image]",
        segments: [
          { type: "image", url: "data:image/png;base64,DISPLAY_ONLY", rawUrl: "remote-key" },
        ],
      })
    ).toEqual([{ type: "text", text: "[image: remote-key]" }])
    expect(
      inboundEventToStoredParts({
        plainText: "[image]",
        segments: [{ type: "image", url: "data:image/png;base64,DISPLAY_ONLY" }],
      })
    ).toEqual([{ type: "text", text: "[image]" }])
  })
  it("keeps text and markdown verbatim and marks media", () => {
    expect(
      inboundEventToStoredParts({
        plainText: "ignored",
        segments: [
          { type: "text", text: "hi" },
          { type: "markdown", md: "**bold**" },
          { type: "image", url: "img_key" },
          {
            type: "file",
            url: "file_key",
            name: "a.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
          },
        ],
      })
    ).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "**bold**" },
      { type: "text", text: "[image: img_key]" },
      { type: "text", text: "[file: a.pdf]" },
    ])
  })

  it("preserves distinct non-text occurrences instead of collapsing a shared fallback", () => {
    expect(
      inboundEventToStoredParts({
        plainText: "[location]",
        segments: [
          { type: "location", lat: 1, lon: 2 },
          { type: "location", lat: 3, lon: 4 },
        ],
      })
    ).toEqual([
      { type: "text", text: "[location:1,2]" },
      { type: "text", text: "[location:3,4]" },
    ])
  })

  it("falls back to the plain text when there are no segments", () => {
    expect(inboundEventToStoredParts({ plainText: "fallback", segments: [] })).toEqual([
      { type: "text", text: "fallback" },
    ])
  })
})
