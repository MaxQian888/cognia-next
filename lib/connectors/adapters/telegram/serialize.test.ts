import { escapeMdV2 } from "./markdown-v2"
import { serializeOutbound, serializeReaction } from "./serialize"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"

function makeReq(
  segments: MessageSegment[],
  extra: Partial<OutboundRequest> = {}
): OutboundRequest {
  return {
    conversationRef: {
      platform: "telegram",
      adapterId: "tg-1",
      chatId: "123456789",
    },
    segments,
    metadata: { idempotencyKey: "test-key" },
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// markdown-v2 escape tests
// ---------------------------------------------------------------------------
describe("escapeMdV2", () => {
  it("escapes all 14 special characters", () => {
    // The canonical 14-char string from the Telegram docs
    const input = "_*[]()~`>#+-=|{}.!"
    const result = escapeMdV2(input)
    // Every special char should be preceded by backslash
    expect(result).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!")
  })

  it("leaves normal text untouched", () => {
    expect(escapeMdV2("Hello World")).toBe("Hello World")
  })

  it("escapes a realistic markdown string", () => {
    expect(escapeMdV2("1+1=2")).toBe("1\\+1\\=2")
  })
})

// ---------------------------------------------------------------------------
// serializeOutbound tests
// ---------------------------------------------------------------------------
describe("serializeOutbound", () => {
  it("text segment → sendMessage", () => {
    const calls = serializeOutbound(makeReq([{ type: "text", text: "Hello!" }]))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendMessage")
    expect(calls[0].payload).toMatchObject({ chat_id: "123456789", text: "Hello!" })
    // no parse_mode for plain text
    expect(calls[0].payload).not.toHaveProperty("parse_mode")
  })

  it("markdown segment → sendMessage with parse_mode MarkdownV2 and CONVERTED markup", () => {
    // Audited fix #5: **bold** must become a real *bold* entity, not the
    // escaped literal source; plain-text specials still get escaped.
    const calls = serializeOutbound(makeReq([{ type: "markdown", md: "**bold** & 1+1" }]))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendMessage")
    expect(calls[0].payload["parse_mode"]).toBe("MarkdownV2")
    expect(calls[0].payload["text"]).toBe("*bold* & 1\\+1")
  })

  it("markdown links keep the URL usable, escaping only ) and \\ in it", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "markdown", md: "[docs](https://x.dev/a_(b))" }])
    )
    expect(calls[0].payload["text"]).toBe("[docs](https://x.dev/a_(b\\))")
  })

  it("image segment → sendPhoto", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "image", url: "https://example.com/img.jpg" }])
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendPhoto")
    expect(calls[0].payload["photo"]).toBe("https://example.com/img.jpg")
  })

  it("voice segment → sendVoice", () => {
    const calls = serializeOutbound(makeReq([{ type: "voice", url: "https://example.com/v.ogg" }]))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendVoice")
    expect(calls[0].payload["voice"]).toBe("https://example.com/v.ogg")
  })

  it("video segment → sendVideo", () => {
    const calls = serializeOutbound(makeReq([{ type: "video", url: "https://example.com/v.mp4" }]))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendVideo")
    expect(calls[0].payload["video"]).toBe("https://example.com/v.mp4")
  })

  it("file segment → sendDocument", () => {
    const calls = serializeOutbound(
      makeReq([
        {
          type: "file",
          url: "https://example.com/f.pdf",
          name: "f.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1234,
        },
      ])
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendDocument")
    expect(calls[0].payload["document"]).toBe("https://example.com/f.pdf")
  })

  it("code segment → sendMessage with MarkdownV2 code block", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "code", language: "ts", code: "const x = 1" }])
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendMessage")
    expect(calls[0].payload["parse_mode"]).toBe("MarkdownV2")
    expect(calls[0].payload["text"]).toContain("```")
  })

  it("code segments escape ONLY ` and \\ inside the fence (audited fix #4a)", () => {
    // `a.b()` must reach Telegram unescaped inside the pre entity — the old
    // path escaped all 18 specials, rendering literal backslashes.
    const calls = serializeOutbound(
      makeReq([{ type: "code", language: "ts", code: "a.b(1) + `tpl` \\ x_y!" }])
    )
    expect(calls[0].payload["text"]).toBe("```ts\na.b(1) + \\`tpl\\` \\\\ x_y!\n```")
  })

  it("sets reply_parameters (Bot API 7.0) when replyTo is provided (audited fix #6)", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "text", text: "hi" }], { replyTo: { messageId: "999" } })
    )
    expect(calls[0].payload["reply_parameters"]).toEqual({ message_id: 999 })
    expect(calls[0].payload).not.toHaveProperty("reply_to_message_id")
  })

  it("accepts the composite chatId:messageId shape in replyTo", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "text", text: "hi" }], { replyTo: { messageId: "123456789:999" } })
    )
    expect(calls[0].payload["reply_parameters"]).toEqual({ message_id: 999 })
  })

  it("text + image sequence produces two calls in order", () => {
    const calls = serializeOutbound(
      makeReq([
        { type: "text", text: "Caption here" },
        { type: "image", url: "https://example.com/img.png" },
      ])
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].method).toBe("sendMessage")
    expect(calls[1].method).toBe("sendPhoto")
  })

  it("forum-thread routing: sets message_thread_id", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "text", text: "thread msg" }], { threadId: "42" })
    )
    expect(calls[0].payload["message_thread_id"]).toBe(42)
  })

  it("emoji segment → sendMessage with the emoji as text (send.emoji)", () => {
    const calls = serializeOutbound(makeReq([{ type: "emoji", code: "🎉" }]))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendMessage")
    expect(calls[0].payload["text"]).toBe("🎉")
  })
})

// ---------------------------------------------------------------------------
// 4096-char chunking (audited fix #7)
// ---------------------------------------------------------------------------
describe("serializeOutbound — long-message chunking", () => {
  it("splits sendMessage text over 4096 chars into sequential sends", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line number ${i}`).join("\n") // > 4096
    const calls = serializeOutbound(makeReq([{ type: "text", text: long }]))
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call.method).toBe("sendMessage")
      expect((call.payload["text"] as string).length).toBeLessThanOrEqual(4096)
      expect(call.payload["chat_id"]).toBe("123456789")
    }
    // Newline-preferred boundaries → joining restores the original text.
    expect(calls.map((c) => c.payload["text"]).join("\n")).toBe(long)
  })

  it("keeps reply_parameters on the FIRST chunk only", () => {
    const long = ("x".repeat(100) + "\n").repeat(50) // 5050 chars
    const calls = serializeOutbound(
      makeReq([{ type: "text", text: long.trimEnd() }], { replyTo: { messageId: "7" } })
    )
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[0].payload["reply_parameters"]).toEqual({ message_id: 7 })
    for (const call of calls.slice(1)) {
      expect(call.payload).not.toHaveProperty("reply_parameters")
    }
  })

  it("leaves short messages as a single call", () => {
    const calls = serializeOutbound(makeReq([{ type: "text", text: "short" }]))
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// serializeReaction (A1 — setMessageReaction)
// ---------------------------------------------------------------------------
describe("serializeReaction", () => {
  it("builds setMessageReaction with a single emoji", () => {
    const call = serializeReaction("123456789", 42, "👍")
    expect(call.method).toBe("setMessageReaction")
    expect(call.payload["chat_id"]).toBe("123456789")
    expect(call.payload["message_id"]).toBe(42)
    expect(call.payload["reaction"]).toEqual([{ type: "emoji", emoji: "👍" }])
  })

  it("accepts an emoji array and emits one ReactionType per entry", () => {
    const call = serializeReaction("c1", "100", ["👍", "❤"])
    expect(call.payload["reaction"]).toEqual([
      { type: "emoji", emoji: "👍" },
      { type: "emoji", emoji: "❤" },
    ])
  })

  it("clears the bot's reactions when passed an empty array", () => {
    const call = serializeReaction("c1", 1, [])
    expect(call.payload["reaction"]).toEqual([])
  })

  it("clears the bot's reactions when passed an empty string", () => {
    const call = serializeReaction("c1", 1, "")
    expect(call.payload["reaction"]).toEqual([])
  })

  it("opts.isBig adds is_big=true to the payload", () => {
    const call = serializeReaction("c1", 1, "🎉", { isBig: true })
    expect(call.payload["is_big"]).toBe(true)
  })

  it("omits is_big when opts.isBig is false/undefined", () => {
    const calA = serializeReaction("c1", 1, "🎉")
    const calB = serializeReaction("c1", 1, "🎉", { isBig: false })
    expect(calA.payload["is_big"]).toBeUndefined()
    expect(calB.payload["is_big"]).toBeUndefined()
  })

  it("coerces messageId strings to numbers (Telegram requires int)", () => {
    const call = serializeReaction("c1", "12345", "👍")
    expect(call.payload["message_id"]).toBe(12345)
    expect(typeof call.payload["message_id"]).toBe("number")
  })
})
