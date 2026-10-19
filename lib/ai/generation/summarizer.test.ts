import { structuralSummary, renderConversation } from "./summarizer"
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
