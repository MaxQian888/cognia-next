import { deriveTimelineTurns } from "./use-timeline-turns"
import type { UIMessage } from "ai"

function userMsg(id: string, text: string, extra: Record<string, unknown> = {}): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }], ...extra } as unknown as UIMessage
}
function asstMsg(id: string, text = "ok"): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] } as unknown as UIMessage
}

describe("deriveTimelineTurns", () => {
  it("returns one turn per user message with reply counts", () => {
    const turns = deriveTimelineTurns([
      userMsg("u1", "first question"),
      asstMsg("a1"),
      asstMsg("a2"),
      userMsg("u2", "second question"),
      asstMsg("a3"),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ id: "u1", index: 0, replyCount: 2 })
    expect(turns[1]).toMatchObject({ id: "u2", index: 3, replyCount: 1 })
  })

  it("uses the first non-empty line as the label", () => {
    const [turn] = deriveTimelineTurns([userMsg("u1", "\n\n  Refactor list  \nmore")])
    expect(turn.label).toBe("Refactor list")
  })

  it("prefers a cached minimapLabel over the raw text", () => {
    const [turn] = deriveTimelineTurns([
      userMsg("u1", "a very long original message body", {
        metadata: { minimapLabel: "Refactor" },
      }),
    ])
    expect(turn.label).toBe("Refactor")
  })

  it("truncates long labels and exposes a longer preview", () => {
    const long = "x".repeat(400)
    const [turn] = deriveTimelineTurns([userMsg("u1", long)])
    expect(turn.label.endsWith("…")).toBe(true)
    expect(turn.label.length).toBeLessThanOrEqual(41)
    expect(turn.preview.length).toBeGreaterThan(turn.label.length)
  })

  it("carries createdAt through as time when present", () => {
    const [turn] = deriveTimelineTurns([userMsg("u1", "hi", { createdAt: 1234 })])
    expect(turn.time).toBe(1234)
  })

  it("ignores assistant-only prefixes", () => {
    const turns = deriveTimelineTurns([asstMsg("a0"), userMsg("u1", "q")])
    expect(turns).toHaveLength(1)
    expect(turns[0].id).toBe("u1")
  })
})
