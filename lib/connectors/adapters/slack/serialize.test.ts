import type { OutboundRequest } from "@/types/connectors/outbound"
import {
  serializeOutbound,
  serializePostMessage,
  serializeUpdate,
  serializeDeleteMessage,
  serializeReaction,
  serializeReactionRemoval,
  serializeAssistantStatus,
  serializeAssistantSuggestedPrompts,
  SlackEmptyMessageError,
} from "./serialize"

function makeRef(channelId: string, threadTs?: string): Record<string, unknown> {
  return { platform: "slack", adapterId: "sl-1", channelId, ...(threadTs ? { threadTs } : {}) }
}

describe("serializePostMessage / serializeOutbound", () => {
  it("builds POST chat.postMessage with channel + blocks", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      segments: [{ type: "text", text: "hello world" }],
      metadata: { idempotencyKey: "k1" },
    }
    const call = serializeOutbound(req)
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://slack.com/api/chat.postMessage")
    expect(call.payload["channel"]).toBe("C123")
    expect(Array.isArray(call.payload["blocks"])).toBe(true)
    expect(call.payload["thread_ts"]).toBeUndefined()
  })

  it("includes thread_ts when conversationRef has threadTs", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123", "1714900000.000100") as never,
      segments: [{ type: "text", text: "thread reply" }],
      metadata: { idempotencyKey: "k2" },
    }
    const call = serializePostMessage(req)
    expect(call.payload["thread_ts"]).toBe("1714900000.000100")
  })

  it("image segment produces image block in blocks[]", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      segments: [{ type: "image", url: "https://example.com/img.png", alt: "pic" }],
      metadata: { idempotencyKey: "k3" },
    }
    const call = serializeOutbound(req)
    const blocks = call.payload["blocks"] as Array<Record<string, unknown>>
    expect(blocks[0]["type"]).toBe("image")
    expect(blocks[0]["image_url"]).toBe("https://example.com/img.png")
  })

  it("markdown segment produces mrkdwn section block", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      segments: [{ type: "markdown", md: "**bold** text" }],
      metadata: { idempotencyKey: "k4" },
    }
    const call = serializeOutbound(req)
    const blocks = call.payload["blocks"] as Array<Record<string, unknown>>
    expect(blocks[0]["type"]).toBe("section")
  })

  it("always includes a top-level text notification fallback beside blocks", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      segments: [{ type: "text", text: "hello world" }],
      metadata: { idempotencyKey: "k-fb" },
    }
    const call = serializePostMessage(req)
    expect(call.payload["text"]).toBe("hello world")
    expect(Array.isArray(call.payload["blocks"])).toBe(true)
  })

  it("sends text-only when every segment was dropped by the block serializer", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      // voice segments produce no block, but do produce plain text.
      segments: [{ type: "voice", url: "https://example.com/v.ogg" }],
      metadata: { idempotencyKey: "k-voice" },
    }
    const call = serializePostMessage(req)
    expect(call.payload["blocks"]).toBeUndefined()
    expect(call.payload["text"]).toBe("[voice]")
  })

  it("throws SlackEmptyMessageError when both blocks and text are empty", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      segments: [],
      metadata: { idempotencyKey: "k-empty" },
    }
    expect(() => serializePostMessage(req)).toThrow(SlackEmptyMessageError)
  })

  it("clamps blocks to Slack's 50-block cap", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      segments: Array.from({ length: 60 }, (_, i) => ({
        type: "text" as const,
        text: `line ${i}`,
      })),
      metadata: { idempotencyKey: "k-cap" },
    }
    const call = serializePostMessage(req)
    expect((call.payload["blocks"] as unknown[]).length).toBe(50)
  })
})

describe("serializeUpdate", () => {
  it("builds POST chat.update with channel, ts, blocks", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      segments: [{ type: "text", text: "edited" }],
      metadata: { idempotencyKey: "k5" },
    }
    const call = serializeUpdate("C123", "1714900000.000100", req)
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://slack.com/api/chat.update")
    expect(call.payload["channel"]).toBe("C123")
    expect(call.payload["ts"]).toBe("1714900000.000100")
    expect(Array.isArray(call.payload["blocks"])).toBe(true)
    // Same notification fallback as chat.postMessage.
    expect(call.payload["text"]).toBe("edited")
  })

  it("throws SlackEmptyMessageError for an all-empty update", () => {
    const req: OutboundRequest = {
      conversationRef: makeRef("C123") as never,
      segments: [],
      metadata: { idempotencyKey: "k5e" },
    }
    expect(() => serializeUpdate("C123", "1714900000.000100", req)).toThrow(SlackEmptyMessageError)
  })
})

describe("serializeDeleteMessage", () => {
  it("builds POST chat.delete with channel and ts", () => {
    const call = serializeDeleteMessage("C123", "1714900000.000100")
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://slack.com/api/chat.delete")
    expect(call.payload["channel"]).toBe("C123")
    expect(call.payload["ts"]).toBe("1714900000.000100")
  })
})

describe("serializeReaction", () => {
  it("builds POST reactions.add with channel, timestamp, name", () => {
    const call = serializeReaction("C123", "1714900000.000100", "thumbsup")
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://slack.com/api/reactions.add")
    expect(call.payload["channel"]).toBe("C123")
    expect(call.payload["timestamp"]).toBe("1714900000.000100")
    expect(call.payload["name"]).toBe("thumbsup")
  })
})

describe("serializeReactionRemoval", () => {
  it("builds POST reactions.remove with channel, timestamp, name", () => {
    const call = serializeReactionRemoval("C123", "1714900000.000100", "thumbsup")
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://slack.com/api/reactions.remove")
    expect(call.payload).toEqual({
      channel: "C123",
      timestamp: "1714900000.000100",
      name: "thumbsup",
    })
  })
})

describe("serializeAssistantStatus", () => {
  it("builds POST assistant.threads.setStatus with channel_id + thread_ts + status", () => {
    const call = serializeAssistantStatus("C123", "1714900000.000100", "is typing…")
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://slack.com/api/assistant.threads.setStatus")
    expect(call.payload).toEqual({
      channel_id: "C123",
      thread_ts: "1714900000.000100",
      status: "is typing…",
    })
  })

  it("uses an empty status string to clear the indicator", () => {
    const call = serializeAssistantStatus("C123", "1.0", "")
    expect(call.payload["status"]).toBe("")
  })
})

describe("serializeAssistantSuggestedPrompts", () => {
  it("builds POST assistant.threads.setSuggestedPrompts with the prompts array", () => {
    const prompts = [
      { title: "Summarise this", message: "Summarise the thread" },
      { title: "Plan", message: "Outline next steps" },
    ]
    const call = serializeAssistantSuggestedPrompts("C123", "1.0", prompts, "Quick actions")
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://slack.com/api/assistant.threads.setSuggestedPrompts")
    expect(call.payload).toEqual({
      channel_id: "C123",
      thread_ts: "1.0",
      prompts,
      title: "Quick actions",
    })
  })

  it("trims prompts to Slack's hard cap of 4", () => {
    const prompts = Array.from({ length: 6 }, (_, i) => ({
      title: `t${i}`,
      message: `m${i}`,
    }))
    const call = serializeAssistantSuggestedPrompts("C123", "1.0", prompts)
    expect((call.payload["prompts"] as unknown[]).length).toBe(4)
  })

  it("omits the title field when not provided", () => {
    const call = serializeAssistantSuggestedPrompts("C123", "1.0", [{ title: "x", message: "y" }])
    expect("title" in call.payload).toBe(false)
  })
})
