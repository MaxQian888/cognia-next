import type { UIMessage } from "ai"

import {
  TOOL_INTERRUPTED_ERROR_TEXT,
  closeEndedTurnToolParts,
  closeOpenToolParts,
  hasOpenToolParts,
  isOpenToolPart,
} from "./phantom-run"

const user = (id: string, metadata?: Record<string, unknown>): UIMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text: id }],
    ...(metadata ? { metadata } : {}),
  }) as UIMessage

const assistant = (id: string, parts: unknown[]): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage

const tool = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  type: "tool-Read",
  toolCallId: id,
  state,
  input: { path: `${id}.ts` },
  ...extra,
})

const failedMark = (detail?: string) => ({
  turnAdmission: {
    state: "failed",
    code: "external_agent_error",
    at: 1,
    ...(detail ? { detail } : {}),
  },
})

describe("isOpenToolPart", () => {
  it("treats streaming, executing and approval-waiting tool calls as open", () => {
    expect(isOpenToolPart(tool("a", "input-streaming"))).toBe(true)
    expect(isOpenToolPart(tool("a", "input-available"))).toBe(true)
    expect(isOpenToolPart(tool("a", "approval-requested"))).toBe(true)
    expect(isOpenToolPart({ type: "dynamic-tool", state: "input-available" })).toBe(true)
  })

  it("treats settled tool calls and non-tool parts as closed", () => {
    expect(isOpenToolPart(tool("a", "output-available"))).toBe(false)
    expect(isOpenToolPart(tool("a", "output-error"))).toBe(false)
    expect(isOpenToolPart(tool("a", "output-denied"))).toBe(false)
    expect(isOpenToolPart({ type: "text", state: "streaming" })).toBe(false)
    expect(isOpenToolPart(null)).toBe(false)
  })
})

describe("closeOpenToolParts", () => {
  it("closes every open call as interrupted, keeping its input and the settled ones", () => {
    const done = tool("done", "output-available", { output: "ok" })
    const messages = [
      user("u1"),
      assistant("a1", [done, tool("open", "input-available"), { type: "text", text: "hi" }]),
    ]
    const { messages: next, changed } = closeOpenToolParts(
      messages,
      "Request timeout: session/prompt"
    )
    expect(changed.map((message) => message.id)).toEqual(["a1"])
    const parts = next[1].parts as Array<Record<string, unknown>>
    expect(parts[0]).toBe(done)
    expect(parts[1]).toEqual({
      type: "tool-Read",
      toolCallId: "open",
      state: "output-error",
      input: { path: "open.ts" },
      errorText: `${TOOL_INTERRUPTED_ERROR_TEXT} (Request timeout: session/prompt)`,
    })
    expect(parts[2]).toEqual({ type: "text", text: "hi" })
    expect(next[0]).toBe(messages[0])
    expect(hasOpenToolParts(next)).toBe(false)
  })

  it("returns the same array when nothing is open", () => {
    const messages = [user("u1"), assistant("a1", [tool("t", "output-available")])]
    const result = closeOpenToolParts(messages)
    expect(result.messages).toBe(messages)
    expect(result.changed).toEqual([])
  })

  it("never touches a user message", () => {
    const odd = { id: "u", role: "user", parts: [tool("t", "input-available")] } as UIMessage
    expect(closeOpenToolParts([odd]).messages[0]).toBe(odd)
  })
})

describe("closeEndedTurnToolParts", () => {
  it("closes calls of turns a later user message proves are over", () => {
    const messages = [
      user("u1"),
      assistant("a1", [tool("old", "input-available")]),
      user("u2"),
      assistant("a2", [tool("live", "input-available")]),
    ]
    const { messages: next, changed } = closeEndedTurnToolParts(messages)
    expect(changed.map((message) => message.id)).toEqual(["a1"])
    expect((next[1].parts[0] as { state: string }).state).toBe("output-error")
    // The trailing turn may still be running somewhere this realm cannot see.
    expect(next[3]).toBe(messages[3])
  })

  it("closes the trailing turn when its user message is marked failed, citing the failure", () => {
    const messages = [
      user("u1", failedMark("Request timeout: session/prompt")),
      assistant("a1", [tool("t", "input-available")]),
    ]
    const { changed } = closeEndedTurnToolParts(messages)
    expect(changed).toHaveLength(1)
    expect((changed[0].parts[0] as { errorText: string }).errorText).toContain(
      "Request timeout: session/prompt"
    )
  })

  it("leaves a failed trailing turn alone while the session is busy (a retry may be running)", () => {
    const messages = [user("u1", failedMark()), assistant("a1", [tool("t", "input-available")])]
    expect(closeEndedTurnToolParts(messages, { trailingMayBeLive: true }).messages).toBe(messages)
  })

  it("is a no-op on a transcript with no user turn", () => {
    const messages = [assistant("greeting", [tool("t", "input-available")])]
    expect(closeEndedTurnToolParts(messages).changed).toEqual([])
  })
})
