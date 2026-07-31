import {
  summarizeConversation,
  structuralSummary,
  renderConversation,
  generateAICompressionSummary,
} from "./summarizer"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { UIMessage } from "ai"

function msg(role: UIMessage["role"], text: string): UIMessage {
  return { id: `${role}-${text}`, role, parts: [{ type: "text", text }] } as UIMessage
}

describe("renderConversation", () => {
  it("renders role-labelled lines and skips empty turns", () => {
    const empty = { id: "x", role: "assistant", parts: [{ type: "tool" }] } as unknown as UIMessage
    const out = renderConversation([msg("user", "hi"), empty, msg("assistant", "yo")])
    expect(out).toBe("User: hi\n\nAssistant: yo")
  })

  it("falls back to the raw role for unknown roles", () => {
    const odd = {
      id: "x",
      role: "tool",
      parts: [{ type: "text", text: "ping" }],
    } as unknown as UIMessage
    expect(renderConversation([odd])).toBe("tool: ping")
  })
})

describe("structuralSummary", () => {
  it("returns empty for no messages", () => {
    expect(structuralSummary([])).toBe("")
  })

  it("lists all messages when short", () => {
    const out = structuralSummary([msg("user", "a"), msg("assistant", "b")])
    expect(out).toContain("2 messages")
    expect(out).toContain("User: a")
    expect(out).toContain("Assistant: b")
  })

  it("elides the middle when long", () => {
    const many = Array.from({ length: 10 }, (_, i) => msg("user", `m${i}`))
    const out = structuralSummary(many)
    expect(out).toContain("4 messages elided")
    expect(out).toContain("Beginning:")
    expect(out).toContain("Recent:")
  })

  it("uses a [role] placeholder for an empty turn", () => {
    const empty = { id: "x", role: "assistant", parts: [{ type: "tool" }] } as unknown as UIMessage
    expect(structuralSummary([empty])).toContain("[assistant]")
  })
})

describe("summarizeConversation", () => {
  const fakeClient = (text: string): LlmClient =>
    ({ complete: jest.fn().mockResolvedValue(text) }) as unknown as LlmClient

  it("returns empty for no messages", async () => {
    expect(await summarizeConversation([])).toBe("")
  })

  it("falls back to structural digest without a client", async () => {
    const out = await summarizeConversation([msg("user", "a")], { client: null })
    expect(out).toContain("User: a")
  })

  it("uses the LLM client output when available", async () => {
    const client = fakeClient("A neat summary.")
    const out = await summarizeConversation([msg("user", "hello")], { client, locale: "en" })
    expect(out).toBe("A neat summary.")
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it("works without a locale hint", async () => {
    const out = await summarizeConversation([msg("user", "hello")], { client: fakeClient("S") })
    expect(out).toBe("S")
  })

  it("falls back when the client returns blank", async () => {
    const out = await summarizeConversation([msg("user", "hello")], { client: fakeClient("   ") })
    expect(out).toContain("User: hello")
  })

  it("falls back when the client throws", async () => {
    const client = {
      complete: jest.fn().mockRejectedValue(new Error("boom")),
    } as unknown as LlmClient
    const out = await summarizeConversation([msg("user", "hello")], { client })
    expect(out).toContain("User: hello")
  })

  it("falls back when the transcript is empty (tool-only turns)", async () => {
    const toolOnly = {
      id: "t",
      role: "assistant",
      parts: [{ type: "tool" }],
    } as unknown as UIMessage
    const out = await summarizeConversation([toolOnly], { client: fakeClient("x") })
    // structuralSummary still produces a digest from the raw message.
    expect(out).toContain("assistant")
  })
})

describe("generateAICompressionSummary (legacy)", () => {
  it("produces a structural digest", async () => {
    const out = await generateAICompressionSummary([msg("user", "a")], {
      provider: "p",
      model: "m",
      apiKey: "k",
    })
    expect(out).toContain("User: a")
  })
})
