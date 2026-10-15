import type { UIMessage } from "ai"
import {
  ASIDE_CONTEXT_MAX_MESSAGES,
  ASIDE_TOOL_FACTS_PER_MESSAGE,
  ASIDE_TOOL_RESULT_EXCERPT_CHARS,
  buildAsideContext,
  prepareAsideContext,
  ASIDE_REFERENCE_HEADER,
  ASIDE_DELTA_HEADER,
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

describe("incremental aside delivery", () => {
  const parent = [msg("user", "question"), msg("assistant", "answer")]
  const full = prepareAsideContext(parent)
  const cursor = { ...full.cursor!, sdkSessionId: "sdk" }
  it("sends a full reference snapshot initially and nothing on an unchanged resume", () => {
    expect(full.header).toBe(ASIDE_REFERENCE_HEADER)
    expect(full.context).toContain("User: question")
    expect(prepareAsideContext(parent, { cursor, resumeSdkSessionId: "sdk" })).toEqual({
      header: ASIDE_DELTA_HEADER,
      context: "",
    })
  })
  it("sends only new messages on the same provider history", () => {
    const delivery = prepareAsideContext([...parent, msg("user", "next")], {
      cursor,
      resumeSdkSessionId: "sdk",
    })
    expect(delivery.context).toBe("User: next")
    expect(delivery.header).toBe(ASIDE_DELTA_HEADER)
    expect(delivery.cursor?.parentMessageId).toBe("user-next")
  })
  it.each([undefined, "another-sdk"])(
    "resends the snapshot on changed or cleared SDK identity: %s",
    (resumeSdkSessionId) => {
      expect(prepareAsideContext(parent, { cursor, resumeSdkSessionId }).context).toBe(full.context)
    }
  )
  it("resends after edits, branch removal, truncation, or parent clearing", () => {
    const edited = [{ ...parent[0], parts: [{ type: "text" as const, text: "edited" }] }, parent[1]]
    for (const messages of [edited, parent.slice(0, 1), []]) {
      const delivery = prepareAsideContext(messages, { cursor, resumeSdkSessionId: "sdk" })
      expect(delivery.header).toBe(ASIDE_REFERENCE_HEADER)
      expect(delivery.context).not.toBe("")
    }
  })
  it("marks streamed content without acknowledging it, then delivers its final form", () => {
    const stream = prepareAsideContext(parent, { inProgressMessageId: parent[1].id })
    expect(stream.context).toContain("still in progress")
    expect(stream.cursor?.parentMessageId).toBe(parent[0].id)
    const final = prepareAsideContext(parent, {
      cursor: { ...stream.cursor!, sdkSessionId: "sdk" },
      resumeSdkSessionId: "sdk",
    })
    expect(final.context).toBe("Assistant: answer")
  })
  it("never acknowledges completed messages displaced by an oversized streaming tail", () => {
    const long = msg("assistant", "x".repeat(9000))
    const delivery = prepareAsideContext([parent[0], long], { inProgressMessageId: long.id })
    expect(delivery.cursor).toBeUndefined()
  })
  it("keeps rebuilding-lane snapshots complete regardless of a stored cursor", () => {
    expect(prepareAsideContext(parent, { cursor }).context).toBe(full.context)
    expect(prepareAsideContext(parent, { cursor }).context).toBe(full.context)
  })
})

it("acknowledges an empty parent once, then sends only subsequent messages", () => {
  const initial = prepareAsideContext([msg("user", "old")])
  const cleared = prepareAsideContext([], {
    cursor: { ...initial.cursor!, sdkSessionId: "sdk" },
    resumeSdkSessionId: "sdk",
  })
  expect(cleared.context).toContain("no visible messages")
  expect(cleared.cursor?.parentMessageId).toBeNull()
  const cursor = { ...cleared.cursor!, sdkSessionId: "sdk" }
  expect(prepareAsideContext([], { cursor, resumeSdkSessionId: "sdk" }).context).toBe("")
  expect(
    prepareAsideContext([msg("user", "new")], { cursor, resumeSdkSessionId: "sdk" }).context
  ).toBe("User: new")
})

it("does not advance past a streaming assistant when a parent steer follows it", () => {
  const question = msg("user", "question")
  const streaming = msg("assistant", "partial")
  const steer = msg("user", "also check this")
  const delivery = prepareAsideContext([question, streaming, steer], {
    inProgressMessageId: streaming.id,
  })
  expect(delivery.cursor?.parentMessageId).toBe(question.id)
  expect(delivery.context).toContain("still in progress")
  const final = prepareAsideContext(
    [question, { ...streaming, parts: [{ type: "text", text: "final answer" }] }, steer],
    {
      cursor: { ...delivery.cursor!, sdkSessionId: "sdk" },
      resumeSdkSessionId: "sdk",
    }
  )
  expect(final.context).toContain("final answer")
  expect(final.cursor?.parentMessageId).toBe(steer.id)
})
