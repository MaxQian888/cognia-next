// Snapshot-reconstruction tests for imported Claude Code subagents (T2a-sub).

import {
  buildSubagentSnapshot,
  deriveSubagentToolCalls,
  deriveSubagentFinalResponse,
  deriveSubagentTokenUsage,
} from "./claude-code-subagent"
import type { StoredMessage } from "@cognia/agent-config-types"

function msg(role: StoredMessage["role"], parts: unknown[], metadata?: unknown): StoredMessage {
  return {
    id: `m-${role}-${Math.round(parts.length)}`,
    sessionId: "s",
    role,
    parts: parts as StoredMessage["parts"],
    ...(metadata ? { metadata: metadata as StoredMessage["metadata"] } : {}),
    createdAt: 0,
  }
}

const NESTED: StoredMessage[] = [
  msg("user", [{ type: "text", text: "go research" }]),
  msg(
    "assistant",
    [
      { type: "text", text: "looking" },
      {
        type: "tool-Grep",
        toolCallId: "t1",
        state: "output-available",
        input: { q: "x" },
        output: "hit",
      },
      { type: "tool-Bash", toolCallId: "t2", state: "output-error", input: {}, errorText: "boom" },
    ],
    { usage: { inputTokens: 100, outputTokens: 20 } }
  ),
  msg("assistant", [{ type: "text", text: "FINAL ANSWER" }], {
    usage: { inputTokens: 5, outputTokens: 8 },
  }),
]

describe("derive helpers", () => {
  it("collects every tool-<name> part with error state mapped", () => {
    const calls = deriveSubagentToolCalls(NESTED)
    expect(calls).toEqual([
      { id: "t1", name: "Grep", input: { q: "x" }, output: "hit", state: "done" },
      { id: "t2", name: "Bash", input: {}, isError: true, state: "error" },
    ])
  })

  it("takes the last non-empty assistant text as the final response", () => {
    expect(deriveSubagentFinalResponse(NESTED)).toBe("FINAL ANSWER")
  })

  it("sums per-turn usage across the run", () => {
    expect(deriveSubagentTokenUsage(NESTED)).toEqual({
      promptTokens: 105,
      completionTokens: 28,
      totalTokens: 133,
    })
  })

  it("returns undefined usage when no turn carries metadata", () => {
    expect(deriveSubagentTokenUsage([msg("user", [{ type: "text", text: "hi" }])])).toBeUndefined()
  })

  it("handles a tool part with no input and synthesizes an id when missing", () => {
    const calls = deriveSubagentToolCalls([
      msg("assistant", [{ type: "tool-Read", state: "output-available", output: "x" }]),
    ])
    expect(calls[0].name).toBe("Read")
    expect(calls[0].input).toBeUndefined()
    expect(calls[0].id).toBe("Read-0")
  })
})

describe("buildSubagentSnapshot", () => {
  it("assembles a completed SubagentPart identical in shape to a native run", () => {
    const part = buildSubagentSnapshot({
      subagentId: "sc1",
      parentSessionId: "import:claude-code:s",
      name: "researcher",
      nestedSessionId: "import:claude-code:s:sub:sc1",
      messages: NESTED,
      startedAt: 1000,
      completedAt: 2000,
    })
    expect(part.type).toBe("subagent")
    expect(part.status).toBe("completed")
    expect(part.progress).toBe(100)
    expect(part.subagentId).toBe("sc1")
    expect(part.nestedSessionId).toBe("import:claude-code:s:sub:sc1")
    expect(part.toolUses).toBe(2)
    expect(part.toolCalls).toHaveLength(2)
    expect(part.finalResponse).toBe("FINAL ANSWER")
    expect(part.tokenUsage).toEqual({ promptTokens: 105, completionTokens: 28, totalTokens: 133 })
    expect(part.completedAt).toBe(2000)
  })
})
