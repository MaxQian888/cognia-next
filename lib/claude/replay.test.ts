// ADR-0028 Phase 6 — buildReplayPrompt unit tests.

import { buildReplayPrompt, flattenMessageText } from "./replay"
import type { StoredMessage } from "@cognia/agent-config-types"

function msg(
  role: "user" | "assistant" | "system",
  text: string,
  id = role + "-" + text.slice(0, 8)
): StoredMessage {
  return {
    id,
    sessionId: "s1",
    role,
    parts: [{ type: "text", text }] as StoredMessage["parts"],
    createdAt: 0,
  }
}

describe("flattenMessageText", () => {
  it("joins all text parts", () => {
    const m = {
      id: "m",
      sessionId: "s1",
      role: "assistant",
      parts: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
      createdAt: 0,
    } as StoredMessage
    expect(flattenMessageText(m)).toBe("hello world")
  })

  it("returns empty string for non-text parts", () => {
    const m = {
      id: "m",
      sessionId: "s1",
      role: "assistant",
      parts: [{ type: "tool-call", state: "input-available" }],
      createdAt: 0,
    } as unknown as StoredMessage
    expect(flattenMessageText(m)).toBe("")
  })
})

describe("buildReplayPrompt", () => {
  it("returns the current message verbatim when there's no history", () => {
    const got = buildReplayPrompt([], "hi there")
    expect(got).toBe("hi there")
  })

  it("ignores system messages from the replay block", () => {
    const got = buildReplayPrompt(
      [msg("system", "system seed"), msg("user", "first"), msg("assistant", "reply")],
      "next"
    )
    expect(got).not.toContain("system seed")
    expect(got).toContain("USER: first")
    expect(got).toContain("ASSISTANT: reply")
    expect(got).toMatch(/## Current message\s+next$/)
  })

  it("caps the number of turns by maxTurns", () => {
    const many: StoredMessage[] = []
    for (let i = 0; i < 30; i++) {
      many.push(msg(i % 2 === 0 ? "user" : "assistant", `turn-${i}`, `m${i}`))
    }
    const got = buildReplayPrompt(many, "now", { maxTurns: 5 })
    // Newest 5 turns kept (turn-25 … turn-29).
    expect(got).toContain("turn-29")
    expect(got).toContain("turn-25")
    expect(got).not.toContain("turn-24")
  })

  it("respects the maxChars budget by elision", () => {
    const huge: StoredMessage[] = []
    for (let i = 0; i < 20; i++) {
      huge.push(msg(i % 2 === 0 ? "user" : "assistant", "x".repeat(2_000), `m${i}`))
    }
    const got = buildReplayPrompt(huge, "now", { maxChars: 5_000 })
    // At least one turn made it in; elision note shows up when older
    // turns were dropped.
    expect(got).toContain("USER:")
    // Final message is preserved.
    expect(got).toContain("## Current message\n\nnow")
  })

  it("formats the header with ADR reference", () => {
    const got = buildReplayPrompt([msg("user", "earlier")], "now")
    expect(got).toContain("Prior conversation")
    expect(got).toContain("ADR-0028")
  })

  it("trims whitespace on the current message", () => {
    const got = buildReplayPrompt([msg("user", "earlier")], "   spaced   ")
    expect(got.trim().endsWith("spaced")).toBe(true)
  })
})
