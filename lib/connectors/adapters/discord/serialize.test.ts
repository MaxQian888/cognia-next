import {
  serializeOutbound,
  serializeDelete,
  serializeEdit,
  serializeReaction,
  serializeReactionRemoval,
  serializeFetchHistory,
  chunkDiscordContent,
  discordNonce,
  serializeOutboundAsync,
  mergeDiscordContentSegments,
  renderDiscordContentRun,
  DISCORD_MAX_CONTENT_LENGTH,
  DISCORD_NONCE_MAX_LENGTH,
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
// Content-run merging
// ---------------------------------------------------------------------------

describe("renderDiscordContentRun", () => {
  it("separates two block segments with a newline, not a run-on line", () => {
    expect(
      renderDiscordContentRun([
        { type: "text", text: "one" },
        { type: "markdown", md: "two" },
      ])
    ).toBe("one\ntwo")
  })

  it("keeps an inline mention inside the sentence its author spaced", () => {
    expect(
      renderDiscordContentRun([
        { type: "text", text: "Ping " },
        { type: "mention", userId: "42" },
        { type: "text", text: " please" },
      ])
    ).toBe("Ping <@42> please")
  })

  it("puts a fenced code block on its own line at both ends", () => {
    expect(
      renderDiscordContentRun([
        { type: "text", text: "Here is the fix:" },
        { type: "code", code: "x = 1", language: "py" },
        { type: "text", text: "done" },
      ])
    ).toBe("Here is the fix:\n\`\`\`py\nx = 1\n\`\`\`\ndone")
  })

  it("renders a language-less fence", () => {
    expect(renderDiscordContentRun([{ type: "code", code: "raw" }])).toBe("\`\`\`\nraw\n\`\`\`")
  })

  it("trims trailing whitespace and ignores empty pieces", () => {
    expect(
      renderDiscordContentRun([
        { type: "text", text: "hi" },
        { type: "text", text: "" },
        { type: "text", text: "   " },
      ])
    ).toBe("hi")
  })

  it("returns an empty string for no content", () => {
    expect(renderDiscordContentRun([])).toBe("")
  })
})

describe("mergeDiscordContentSegments", () => {
  it("collapses a run into one markdown segment", () => {
    expect(
      mergeDiscordContentSegments([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toEqual([{ type: "markdown", md: "a\nb" }])
  })

  it("lets an a2ui surface break the run and keeps the order", () => {
    const a2ui = {
      type: "a2ui" as const,
      surfaceId: "s1",
      content: { components: {}, dataModel: {}, rootId: "root" },
      plainTextMirror: "mirror",
    }
    const merged = mergeDiscordContentSegments([
      { type: "text", text: "before" },
      a2ui,
      { type: "text", text: "after" },
    ])
    expect(merged).toEqual([
      { type: "markdown", md: "before" },
      a2ui,
      { type: "markdown", md: "after" },
    ])
  })

  it("keeps media segments in place", () => {
    const image = { type: "image" as const, url: "https://x/y.png" }
    expect(mergeDiscordContentSegments([{ type: "text", text: "look" }, image])).toEqual([
      { type: "markdown", md: "look" },
      image,
    ])
  })

  it("drops a reply segment without splitting the run", () => {
    // The reply is expressed through message_reference; letting it split a run
    // would fragment a message for no content at all.
    expect(
      mergeDiscordContentSegments([
        { type: "text", text: "a" },
        { type: "reply", messageId: "1", snippet: "q" },
        { type: "text", text: "b" },
      ])
    ).toEqual([{ type: "markdown", md: "a\nb" }])
  })

  it("emits nothing for a run that renders empty", () => {
    expect(mergeDiscordContentSegments([{ type: "text", text: "  " }])).toEqual([])
  })
})

describe("serializeOutbound — fragmentation", () => {
  it("sends a mixed text + code answer as ONE message", () => {
    const calls = serializeOutbound(
      makeReq([
        { type: "text", text: "Here is the fix:" },
        { type: "code", code: "x = 1", language: "py" },
      ])
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].payload["content"]).toContain("Here is the fix:")
    expect(calls[0].payload["content"]).toContain("x = 1")
  })

  it("pings a reply once, not once per segment", () => {
    // Every segment used to carry message_reference, so a three-part answer
    // notified the user three times.
    const calls = serializeOutbound(
      makeReq([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
        { type: "text", text: "three" },
      ])
    )
    const withReference = calls.filter((c) => c.payload["message_reference"])
    expect(calls).toHaveLength(1)
    expect(withReference.length).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// discordNonce — platform idempotency (ADR-0009)
// ---------------------------------------------------------------------------

describe("discordNonce", () => {
  it("is deterministic for the same key + index and ≤25 chars", () => {
    const a = discordNonce("job-abc", 0)
    const b = discordNonce("job-abc", 0)
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
    expect(a.length).toBeLessThanOrEqual(DISCORD_NONCE_MAX_LENGTH)
    expect(a).toMatch(/^[0-9a-z]+$/)
  })

  it("differs per index and per key (numeric and string indexes)", () => {
    expect(discordNonce("job-abc", 0)).not.toBe(discordNonce("job-abc", 1))
    expect(discordNonce("job-abc", 0)).not.toBe(discordNonce("job-xyz", 0))
    expect(discordNonce("job-abc", "media")).not.toBe(discordNonce("job-abc", "voice:0"))
  })

  it("stays under the cap even for very long keys", () => {
    expect(discordNonce("k".repeat(500), 99).length).toBeLessThanOrEqual(DISCORD_NONCE_MAX_LENGTH)
  })
})

describe("serializeOutbound — nonce stamping", () => {
  it("stamps nonce + enforce_nonce on every message-create call, indexed per call", () => {
    // Two calls because the content exceeds the 2000-char cap and chunks —
    // consecutive content segments now share one message, so the old fixture
    // (a text plus a markdown segment) produces a single call.
    const calls = serializeOutbound(makeReq([{ type: "text", text: "a".repeat(2500) }]))
    expect(calls).toHaveLength(2)
    expect(calls[0].payload).toMatchObject({
      nonce: discordNonce("test-key", 0),
      enforce_nonce: true,
    })
    expect(calls[1].payload).toMatchObject({
      nonce: discordNonce("test-key", 1),
      enforce_nonce: true,
    })
    expect(calls[0].payload["nonce"]).not.toBe(calls[1].payload["nonce"])
  })

  it("re-serializing the same request reproduces identical nonces (retry-safe)", () => {
    const req = makeReq([{ type: "text", text: "a".repeat(4500) }])
    const first = serializeOutbound(req).map((c) => c.payload["nonce"])
    const second = serializeOutbound(req).map((c) => c.payload["nonce"])
    expect(first).toHaveLength(3)
    expect(first).toEqual(second)
    expect(new Set(first).size).toBe(3)
  })

  it("skips stamping when the request has no idempotency key", () => {
    const calls = serializeOutbound(
      makeReq([{ type: "text", text: "x" }], {
        metadata: { idempotencyKey: "" },
      })
    )
    expect(calls[0].payload).not.toHaveProperty("nonce")
    expect(calls[0].payload).not.toHaveProperty("enforce_nonce")
  })

  it("async serializer stamps nonces on a2ui and plain calls alike", async () => {
    const calls = await serializeOutboundAsync(
      makeReq([
        { type: "text", text: "hello" },
        {
          type: "a2ui",
          surfaceId: "s1",
          content: { root: "r", components: [] } as never,
          plainTextMirror: "mirror",
        },
      ]),
      "dc-1"
    )
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const [i, call] of calls.entries()) {
      expect(call.payload["nonce"]).toBe(discordNonce("test-key", i))
      expect(call.payload["enforce_nonce"]).toBe(true)
    }
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

  // ── 2000-char content chunking ─────────────────────────────────────────────

  it("splits an over-limit text segment into multiple ≤2000-char POSTs", () => {
    const text = "a".repeat(4500)
    const calls = serializeOutbound(makeReq([{ type: "text", text }]))
    expect(calls).toHaveLength(3)
    const contents = calls.map((c) => c.payload["content"] as string)
    for (const c of contents) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT_LENGTH)
    }
    expect(contents.join("")).toBe(text)
  })

  it("chunks markdown segments too, attaching message_reference only to the first chunk", () => {
    const md = "x".repeat(2500)
    const calls = serializeOutbound(
      makeReq([{ type: "markdown", md }], { replyTo: { messageId: "999" } })
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].payload["message_reference"]).toBeDefined()
    expect(calls[1].payload["message_reference"]).toBeUndefined()
  })
})

describe("chunkDiscordContent", () => {
  it("returns the text unchanged when within the limit", () => {
    expect(chunkDiscordContent("short")).toEqual(["short"])
    expect(chunkDiscordContent("b".repeat(2000))).toEqual(["b".repeat(2000)])
  })

  it("prefers a newline boundary inside the window", () => {
    const first = "p".repeat(1500)
    const second = "q".repeat(1000)
    const chunks = chunkDiscordContent(`${first}\n${second}`)
    expect(chunks).toEqual([first, second])
  })

  it("hard-cuts at the limit when no newline exists in the window", () => {
    const chunks = chunkDiscordContent("z".repeat(2001))
    expect(chunks).toEqual(["z".repeat(2000), "z"])
  })

  it("never treats a leading newline as a boundary (no empty chunks)", () => {
    const text = "\n" + "y".repeat(2500)
    const chunks = chunkDiscordContent(text)
    expect(chunks.every((c) => c.length > 0)).toBe(true)
    expect(chunks.every((c) => c.length <= 2000)).toBe(true)
    expect(chunks.join("")).toBe(text)
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
