import type { UIMessage } from "ai"
import { ASIDE_CONTEXT_MAX_TURNS, buildAsideContext } from "./session-aside-context"

function msg(role: "user" | "assistant", text: string): UIMessage {
  return { id: `${role}-${text}`, role, parts: [{ type: "text", text }] } as UIMessage
}

describe("buildAsideContext", () => {
  it("returns nothing for an empty conversation", () => {
    expect(buildAsideContext([])).toBe("")
  })

  it("renders the conversation with speaker labels", () => {
    const out = buildAsideContext([msg("user", "hello"), msg("assistant", "hi")])
    expect(out).toBe("User: hello\n\nAssistant: hi")
  })

  it("keeps only the most recent turns", () => {
    const messages = Array.from({ length: ASIDE_CONTEXT_MAX_TURNS + 5 }, (_, i) =>
      msg("user", `m${i}`)
    )
    const out = buildAsideContext(messages)
    // The oldest fall away; the newest — what the user is most likely asking
    // about — always survive.
    expect(out).not.toContain("m0")
    expect(out).toContain(`m${ASIDE_CONTEXT_MAX_TURNS + 4}`)
  })

  it("drops whole messages from the oldest end to fit the char budget", () => {
    const out = buildAsideContext([msg("user", "A".repeat(50)), msg("user", "keep me")], {
      maxChars: 40,
    })
    // A half message reads as an interrupted speaker, which the model imitates.
    expect(out).toBe("User: keep me")
  })

  it("truncates rather than dropping when one message alone exceeds the budget", () => {
    const out = buildAsideContext([msg("user", "B".repeat(100))], { maxChars: 20 })
    expect(out).toHaveLength(20)
    // Keeps the END — the most recent thing said.
    expect(out).toBe("B".repeat(20))
  })

  it("skips messages with no quotable text", () => {
    const toolOnly = { id: "t", role: "assistant", parts: [] } as unknown as UIMessage
    expect(buildAsideContext([toolOnly, msg("user", "only me")])).toBe("User: only me")
  })

  it("returns nothing when the caller allows no budget", () => {
    expect(buildAsideContext([msg("user", "x")], { maxTurns: 0 })).toBe("")
    expect(buildAsideContext([msg("user", "x")], { maxChars: 0 })).toBe("")
  })
})
