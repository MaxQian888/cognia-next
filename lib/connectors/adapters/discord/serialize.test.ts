import {
  serializeOutbound,
  serializeDelete,
  serializeEdit,
  serializeReaction,
  serializeReactionRemoval,
  serializeFetchHistory,
  escapeDiscordMd,
} from "./serialize"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"

function makeReq(
  segments: MessageSegment[],
  extra: Partial<OutboundRequest> = {}
): OutboundRequest {
  return {
    conversationRef: {
      platform: "discord",
      adapterId: "dc-1",
      channelId: "9876543210987654321",
    },
    segments,
    metadata: { idempotencyKey: "test-key" },
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// escapeDiscordMd
// ---------------------------------------------------------------------------

describe("escapeDiscordMd", () => {
  it("escapes asterisk, underscore, tilde, pipe, gt, backslash", () => {
    expect(escapeDiscordMd("*bold* _em_ ~strike~ |text| >quote")).toBe(
      "\\*bold\\* \\_em\\_ \\~strike\\~ \\|text\\| \\>quote"
    )
  })

  it("leaves normal text untouched", () => {
    expect(escapeDiscordMd("Hello world")).toBe("Hello world")
  })

  it("escapes backslash", () => {
    expect(escapeDiscordMd("back\\slash")).toBe("back\\\\slash")
  })
})

// ---------------------------------------------------------------------------
// serializeOutbound
// ---------------------------------------------------------------------------

describe("serializeOutbound", () => {
  it("text segment → POST /messages with content", () => {
    const calls = serializeOutbound(makeReq([{ type: "text", text: "Hello!" }]))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toContain("/channels/9876543210987654321/messages")
    expect(calls[0].payload).toMatchObject({ content: "Hello!" })
  })

  it("markdown segment → POST with raw markdown as content", () => {
    const calls = serializeOutbound(makeReq([{ type: "markdown", md: "**bold**" }]))
    expect(calls).toHaveLength(1)
    expect(calls[0].payload["content"]).toBe("**bold**")
  })

  it("code segment → POST with fenced code block", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "code", language: "ts", code: "const x = 1" }])
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].payload["content"]).toContain("```ts")
    expect(calls[0].payload["content"]).toContain("const x = 1")
  })

  it("image segment → POST with embed image url", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "image", url: "https://example.com/img.png" }])
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].payload["embeds"]).toEqual([{ image: { url: "https://example.com/img.png" } }])
  })

  it("file segment → POST with URL in content", () => {
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
    expect(calls[0].payload["content"]).toBe("https://example.com/f.pdf")
  })

  it("mention segment → POST with <@userId> content", () => {
    const calls = serializeOutbound(makeReq([{ type: "mention", userId: "111111111111111111" }]))
    expect(calls).toHaveLength(1)
    expect(calls[0].payload["content"]).toBe("<@111111111111111111>")
  })

  it("reply segment is a no-op (replyTo on OutboundRequest handles it)", () => {
    const calls = serializeOutbound(makeReq([{ type: "reply", messageId: "123", snippet: "hi" }]))
    expect(calls).toHaveLength(0)
  })

  it("replyTo sets message_reference on the first call", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "text", text: "ok" }], {
        replyTo: { messageId: "9999999999999999999" },
      })
    )
    expect(calls[0].payload["message_reference"]).toMatchObject({
      message_id: "9999999999999999999",
      channel_id: "9876543210987654321",
    })
  })

  it("text + image → two calls in order", () => {
    const calls = serializeOutbound(
      makeReq([
        { type: "text", text: "look:" },
        { type: "image", url: "https://example.com/p.png" },
      ])
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].payload["content"]).toBe("look:")
    expect(calls[1].payload["embeds"]).toBeDefined()
  })

  it("thread: channelId from ref used as channel (thread channel posting)", () => {
    const req = makeReq([{ type: "text", text: "thread msg" }])
    const calls = serializeOutbound(req)
    expect(calls[0].url).toContain("/channels/9876543210987654321/messages")
  })
})

// ---------------------------------------------------------------------------
// serializeDelete / serializeEdit
// ---------------------------------------------------------------------------

describe("serializeDelete", () => {
  it("builds DELETE request with correct url", () => {
    const call = serializeDelete("123", "456")
    expect(call.method).toBe("DELETE")
    expect(call.url).toBe("https://discord.com/api/v10/channels/123/messages/456")
    expect(call.payload).toEqual({})
  })
})

describe("serializeEdit", () => {
  it("builds PATCH request with content", () => {
    const call = serializeEdit("123", "456", "new content")
    expect(call.method).toBe("PATCH")
    expect(call.url).toBe("https://discord.com/api/v10/channels/123/messages/456")
    expect(call.payload).toEqual({ content: "new content" })
  })
})

// ---------------------------------------------------------------------------
// serializeReaction / serializeReactionRemoval (A2 — PUT|DELETE /reactions/{emoji}/@me)
// ---------------------------------------------------------------------------

describe("serializeReaction", () => {
  it("builds PUT to /reactions/{emoji}/@me with URL-encoded unicode emoji", () => {
    const call = serializeReaction("123", "456", "👍")
    expect(call.method).toBe("PUT")
    // encodeURIComponent("👍") → "%F0%9F%91%8D"
    expect(call.url).toBe(
      "https://discord.com/api/v10/channels/123/messages/456/reactions/%F0%9F%91%8D/@me"
    )
    expect(call.payload).toEqual({})
  })

  it("URL-encodes Discord custom-emoji name:id form as a single path segment", () => {
    const call = serializeReaction("123", "456", "thumbsup:43623862374")
    // encodeURIComponent("thumbsup:43623862374") → "thumbsup%3A43623862374"
    expect(call.url).toBe(
      "https://discord.com/api/v10/channels/123/messages/456/reactions/thumbsup%3A43623862374/@me"
    )
  })
})

describe("serializeReactionRemoval", () => {
  it("builds DELETE with the same URL shape as serializeReaction", () => {
    const call = serializeReactionRemoval("123", "456", "👍")
    expect(call.method).toBe("DELETE")
    expect(call.url).toBe(
      "https://discord.com/api/v10/channels/123/messages/456/reactions/%F0%9F%91%8D/@me"
    )
    expect(call.payload).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// serializeFetchHistory (A2.b — GET /channels/:id/messages cursor pagination)
// ---------------------------------------------------------------------------

describe("serializeFetchHistory", () => {
  it("builds GET-shaped URL with limit", () => {
    const call = serializeFetchHistory("123", { limit: 50 })
    expect(call.url).toBe("https://discord.com/api/v10/channels/123/messages?limit=50")
    expect(call.payload).toEqual({})
  })

  it("clamps limit to Discord's 1..100 range", () => {
    const high = serializeFetchHistory("123", { limit: 9999 })
    expect(high.url).toContain("limit=100")
    const low = serializeFetchHistory("123", { limit: 0 })
    expect(low.url).toContain("limit=1")
  })

  it("includes before cursor when provided", () => {
    const call = serializeFetchHistory("123", { limit: 50, before: "9999" })
    expect(call.url).toContain("before=9999")
  })

  it("includes after cursor when provided", () => {
    const call = serializeFetchHistory("123", { limit: 50, after: "1000" })
    expect(call.url).toContain("after=1000")
  })

  it("defaults limit to 50 when omitted", () => {
    const call = serializeFetchHistory("123", {})
    expect(call.url).toContain("limit=50")
  })
})
