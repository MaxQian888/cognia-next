import { createTelegramAlbumBuffer, mergeTelegramAlbum, TELEGRAM_ALBUM_MAX_PARTS } from "./album"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

function part(
  messageId: string,
  segments: MessageSegment[],
  patch: Partial<NormalizedInboundEvent> = {}
): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "tg-1",
    selfId: "bot",
    messageId,
    conversationRef: { platform: "telegram", adapterId: "tg-1" },
    conversationKey: "telegram:tg-1:42",
    sender: { id: "u1", platform: "telegram", adapterId: "tg-1", remoteUserId: "1" },
    channel: { id: "42", kind: "group" },
    segments,
    plainText: segments.map((s) => (s.type === "text" ? s.text : "")).join(""),
    mentions: { selfMentioned: false, users: [] },
    timestamp: Number(messageId),
    raw: { message_id: Number(messageId) },
    ...patch,
  }
}

const photo = (url: string): MessageSegment => ({ type: "image", url })
const text = (value: string): MessageSegment => ({ type: "text", text: value })

describe("mergeTelegramAlbum", () => {
  it("refuses an empty group rather than inventing a message", () => {
    expect(() => mergeTelegramAlbum([])).toThrow(/no parts/)
  })

  it("returns a single part untouched", () => {
    const only = part("7", [photo("a.jpg")])
    expect(mergeTelegramAlbum([only])).toBe(only)
  })

  it("concatenates media in message-id order regardless of arrival order", () => {
    const merged = mergeTelegramAlbum([
      part("12", [photo("c.jpg")]),
      part("10", [text("look"), photo("a.jpg")]),
      part("11", [photo("b.jpg")]),
    ])
    expect(merged.segments).toEqual([text("look"), photo("a.jpg"), photo("b.jpg"), photo("c.jpg")])
  })

  it("anchors identity on the first part — that is what a reply quotes", () => {
    const merged = mergeTelegramAlbum([
      part("11", [photo("b.jpg")], { timestamp: 200 }),
      part("10", [photo("a.jpg")], { timestamp: 100 }),
    ])
    expect(merged.messageId).toBe("10")
    expect(merged.timestamp).toBe(100)
  })

  it("recomputes plainText so a caption on ANY part reaches the trigger matcher", () => {
    // The bug this fixes: Telegram puts the caption on one part, so four of
    // five parts used to be gated against an empty string.
    const merged = mergeTelegramAlbum([
      part("10", [photo("a.jpg")]),
      part("11", [photo("b.jpg"), text("summarise these")]),
    ])
    expect(merged.plainText).toContain("summarise these")
  })

  it("records the member message ids so downstream can see the album", () => {
    const merged = mergeTelegramAlbum([part("10", [photo("a.jpg")]), part("11", [photo("b.jpg")])])
    expect(merged.channelData?.telegramAlbum).toEqual({ messageIds: ["10", "11"] })
  })

  it("keeps existing channelData", () => {
    const merged = mergeTelegramAlbum([
      part("10", [photo("a.jpg")], { channelData: { topicId: "t9" } }),
      part("11", [photo("b.jpg")]),
    ])
    expect(merged.channelData?.topicId).toBe("t9")
  })

  it("adopts a reply descriptor carried by a later part", () => {
    const replyTo = { messageId: "5", snippet: "earlier" }
    const merged = mergeTelegramAlbum([
      part("10", [photo("a.jpg")]),
      part("11", [photo("b.jpg")], { replyTo }),
    ])
    expect(merged.replyTo).toBe(replyTo)
  })

  it("falls back to string ordering when an id is not numeric", () => {
    const merged = mergeTelegramAlbum([part("b", [photo("b.jpg")]), part("a", [photo("a.jpg")])])
    expect(merged.messageId).toBe("a")
  })
})

describe("createTelegramAlbumBuffer", () => {
  let now: number
  let timers: { id: number; at: number; fn: () => void }[]
  let nextTimerId: number

  const setTimer = ((fn: () => void, ms: number) => {
    const id = nextTimerId++
    timers.push({ id, at: now + ms, fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>

  const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
    timers = timers.filter((t) => t.id !== (handle as unknown as number))
  }

  function advance(ms: number): void {
    now += ms
    const due = timers.filter((t) => t.at <= now)
    timers = timers.filter((t) => t.at > now)
    for (const t of due) t.fn()
  }

  beforeEach(() => {
    now = 0
    timers = []
    nextTimerId = 1
  })

  function makeBuffer(overrides: Record<string, unknown> = {}) {
    const flushed: NormalizedInboundEvent[] = []
    const errors: unknown[] = []
    const buffer = createTelegramAlbumBuffer({
      onFlush: (event) => {
        flushed.push(event)
      },
      onError: (error) => errors.push(error),
      windowMs: 1000,
      setTimer,
      clearTimer,
      ...overrides,
    })
    return { buffer, flushed, errors }
  }

  it("passes a non-album event straight through", () => {
    const { buffer, flushed } = makeBuffer()
    expect(buffer.offer(part("1", [text("hi")]), undefined)).toBe(false)
    expect(flushed).toEqual([])
    expect(buffer.openGroups()).toBe(0)
  })

  it("buffers album parts and emits one merged event after the window", () => {
    const { buffer, flushed } = makeBuffer()
    expect(buffer.offer(part("10", [photo("a.jpg")]), "g1")).toBe(true)
    expect(buffer.offer(part("11", [photo("b.jpg")]), "g1")).toBe(true)
    expect(flushed).toHaveLength(0)

    advance(1000)
    expect(flushed).toHaveLength(1)
    expect(flushed[0].segments).toHaveLength(2)
    expect(buffer.openGroups()).toBe(0)
  })

  it("restarts the window on each part so a slow feed still assembles", () => {
    const { buffer, flushed } = makeBuffer()
    buffer.offer(part("10", [photo("a.jpg")]), "g1")
    advance(900)
    buffer.offer(part("11", [photo("b.jpg")]), "g1")
    advance(900)
    expect(flushed).toHaveLength(0)
    advance(200)
    expect(flushed[0].segments).toHaveLength(2)
  })

  it("emits immediately at Telegram's ten-part maximum instead of waiting", () => {
    const { buffer, flushed } = makeBuffer()
    for (let i = 0; i < TELEGRAM_ALBUM_MAX_PARTS; i++) {
      buffer.offer(part(String(10 + i), [photo(`${i}.jpg`)]), "g1")
    }
    expect(flushed).toHaveLength(1)
    expect(flushed[0].segments).toHaveLength(TELEGRAM_ALBUM_MAX_PARTS)
    expect(timers).toHaveLength(0)
  })

  it("keeps concurrent albums apart", () => {
    const { buffer, flushed } = makeBuffer()
    buffer.offer(part("10", [photo("a.jpg")]), "g1")
    buffer.offer(part("20", [photo("x.jpg")]), "g2")
    expect(buffer.openGroups()).toBe(2)
    advance(1000)
    expect(flushed).toHaveLength(2)
    expect(flushed.map((e) => e.messageId).sort()).toEqual(["10", "20"])
  })

  it("keeps the same media_group_id in different conversations apart", () => {
    const { buffer } = makeBuffer()
    buffer.offer(part("10", [photo("a.jpg")]), "g1")
    buffer.offer(part("10", [photo("a.jpg")], { conversationKey: "telegram:tg-1:99" }), "g1")
    expect(buffer.openGroups()).toBe(2)
  })

  it("does not buffer an edit — it addresses one delivered part", () => {
    const { buffer } = makeBuffer()
    expect(buffer.offer(part("10", [photo("a.jpg")], { kind: "edit" }), "g1")).toBe(false)
    expect(buffer.openGroups()).toBe(0)
  })

  it("flushes everything on stop rather than dropping a half-assembled album", async () => {
    const { buffer, flushed } = makeBuffer()
    buffer.offer(part("10", [photo("a.jpg")]), "g1")
    buffer.offer(part("20", [photo("x.jpg")]), "g2")
    await buffer.flushAll()
    expect(flushed).toHaveLength(2)
    expect(buffer.openGroups()).toBe(0)
    // The pending timers must be gone, or a stopped adapter emits again.
    expect(timers).toHaveLength(0)
  })

  it("flushes the oldest group rather than growing without bound", () => {
    const { buffer, flushed } = makeBuffer({ maxOpenGroups: 2 })
    buffer.offer(part("10", [photo("a.jpg")]), "g1")
    buffer.offer(part("20", [photo("b.jpg")]), "g2")
    buffer.offer(part("30", [photo("c.jpg")]), "g3")
    // g1 was evicted — emitted, never dropped.
    expect(flushed).toHaveLength(1)
    expect(flushed[0].messageId).toBe("10")
    expect(buffer.openGroups()).toBe(2)
  })

  it("reports a throwing consumer instead of losing the buffer", () => {
    const errors: unknown[] = []
    const buffer = createTelegramAlbumBuffer({
      onFlush: () => {
        throw new Error("emit failed")
      },
      onError: (error) => errors.push(error),
      windowMs: 1000,
      setTimer,
      clearTimer,
    })
    buffer.offer(part("10", [photo("a.jpg")]), "g1")
    advance(1000)
    expect((errors[0] as Error).message).toBe("emit failed")
    expect(buffer.openGroups()).toBe(0)
  })

  it("reports a rejected async consumer", async () => {
    const errors: unknown[] = []
    const buffer = createTelegramAlbumBuffer({
      onFlush: () => Promise.reject(new Error("emit rejected")),
      onError: (error) => errors.push(error),
      windowMs: 1000,
      setTimer,
      clearTimer,
    })
    buffer.offer(part("10", [photo("a.jpg")]), "g1")
    advance(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect((errors[0] as Error).message).toBe("emit rejected")
  })
})
