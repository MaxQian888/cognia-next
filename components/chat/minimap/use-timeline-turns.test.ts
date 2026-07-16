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

  it("reads time from metadata.createdAt (the shape listMessages hoists)", () => {
    const [turn] = deriveTimelineTurns([userMsg("u1", "hi", { metadata: { createdAt: 1234 } })])
    expect(turn.time).toBe(1234)
  })

  it("leaves time undefined for an unpersisted turn", () => {
    // The turn the user just typed has no createdAt until the first persist —
    // formatTurnTime renders "" rather than a bogus "now".
    const [turn] = deriveTimelineTurns([userMsg("u1", "hi")])
    expect(turn.time).toBeUndefined()
  })

  it("ignores a non-numeric createdAt", () => {
    const [turn] = deriveTimelineTurns([
      userMsg("u1", "hi", { metadata: { createdAt: "2026-07-16" } }),
    ])
    expect(turn.time).toBeUndefined()
  })

  it("collects every message id in a turn, not just the anchoring user one", () => {
    // The bookmark star isn't role-gated, so a starred assistant reply has to
    // resolve back to the turn it belongs to.
    const turns = deriveTimelineTurns([
      userMsg("u1", "q"),
      asstMsg("a1"),
      asstMsg("a2"),
      userMsg("u2", "q2"),
    ])
    expect(turns[0].messageIds).toEqual(["u1", "a1", "a2"])
    expect(turns[1].messageIds).toEqual(["u2"])
  })

  it("ignores assistant-only prefixes", () => {
    const turns = deriveTimelineTurns([asstMsg("a0"), userMsg("u1", "q")])
    expect(turns).toHaveLength(1)
    expect(turns[0].id).toBe("u1")
  })
})
