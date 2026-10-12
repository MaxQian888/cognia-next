import type { UIMessage } from "ai"
import {
  ASIDE_CONTEXT_MAX_MESSAGES,
  ASIDE_TOOL_FACTS_PER_MESSAGE,
  ASIDE_TOOL_RESULT_EXCERPT_CHARS,
  buildAsideContext,
} from "./session-aside-context"

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
    const messages = Array.from({ length: ASIDE_CONTEXT_MAX_MESSAGES + 5 }, (_, i) =>
      msg("user", `m${i}`)
    )
    const out = buildAsideContext(messages)
    // The oldest fall away; the newest — what the user is most likely asking
    // about — always survive.
    expect(out).not.toContain("m0")
    expect(out).toContain(`m${ASIDE_CONTEXT_MAX_MESSAGES + 4}`)
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
    expect(buildAsideContext([msg("user", "x")], { maxMessages: 0 })).toBe("")
    expect(buildAsideContext([msg("user", "x")], { maxChars: 0 })).toBe("")
  })

  it("tells the aside what the main thread learned from its tools", () => {
    const toolTurn = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-Read",
          toolCallId: "c1",
          state: "output-available",
          input: { file_path: "/repo/src/config.ts" },
          output: "export const PORT = 4173",
        },
        {
          type: "tool-Bash",
          toolCallId: "c2",
          state: "output-error",
          input: { command: "pnpm test" },
          errorText: "3 tests failed\nat foo.test.ts",
        },
        {
          type: "tool-Edit",
          toolCallId: "c3",
          state: "output-available",
          input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b\nc" },
          output: "ok",
        },
      ],
    } as unknown as UIMessage
    const out = buildAsideContext([msg("user", "why is the port wrong?"), toolTurn])
    expect(out).toContain("[tool Read config.ts → export const PORT = 4173]")
    expect(out).toContain("[tool Bash pnpm test failed: 3 tests failed]")
    expect(out).toMatch(/\[tool Edit a\.ts: \+\d+ −\d+ lines\]/)
  })

  it("does not let tool-only rows use up the window without contributing", () => {
    const empty = (i: number) =>
      ({ id: `e${i}`, role: "assistant", parts: [] }) as unknown as UIMessage
    const messages = [
      msg("user", "the question"),
      ...Array.from({ length: ASIDE_CONTEXT_MAX_MESSAGES + 4 }, (_, i) => empty(i)),
    ]
    expect(buildAsideContext(messages)).toBe("User: the question")
  })

  it("quotes a bounded excerpt of a large tool result and the tail of a long burst", () => {
    const big = "x".repeat(ASIDE_TOOL_RESULT_EXCERPT_CHARS * 3)
    const burst = {
      id: "a2",
      role: "assistant",
      parts: Array.from({ length: ASIDE_TOOL_FACTS_PER_MESSAGE + 3 }, (_, i) => ({
        type: "tool-Grep",
        toolCallId: `g${i}`,
        state: "output-available",
        input: { pattern: `p${i}` },
        output: i === ASIDE_TOOL_FACTS_PER_MESSAGE + 2 ? big : "hit",
      })),
    } as unknown as UIMessage
    const out = buildAsideContext([burst])
    expect(out).toContain("[3 earlier tool calls omitted]")
    expect(out).not.toContain("Grep p0 ")
    expect(out).toContain(`Grep p${ASIDE_TOOL_FACTS_PER_MESSAGE + 2}`)
    expect(out).toContain("…]")
    expect(out.length).toBeLessThan(big.length)
  })
})
