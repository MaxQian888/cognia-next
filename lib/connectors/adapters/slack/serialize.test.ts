import type { OutboundRequest } from "@/types/connectors/outbound"
import {
  serializeOutbound,
  serializePostMessage,
  serializeUpdate,
  serializeDeleteMessage,
  serializeReaction,
  serializeTyping,
  serializeAssistantStatus,
  serializeAssistantSuggestedPrompts,
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

describe("serializeTyping (deprecated alias)", () => {
  it("still returns null so existing call sites remain safe", () => {
    expect(serializeTyping("C123")).toBeNull()
    expect(serializeTyping("C123", "1714900000.000100")).toBeNull()
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
