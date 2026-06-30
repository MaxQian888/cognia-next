import type { UIMessage } from "ai"

import { buildContextSourceBreakdown } from "@/lib/analysis/context-source-breakdown"

function user(text: string): UIMessage {
  return { id: "u", role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage
}

function assistant(parts: Record<string, unknown>[]): UIMessage {
  return { id: "a", role: "assistant", parts } as unknown as UIMessage
}

describe("buildContextSourceBreakdown", () => {
  it("returns an empty breakdown for no messages", () => {
    expect(buildContextSourceBreakdown([])).toEqual({ rows: [], totalTokens: 0 })
  })

  it("buckets transcript content by source and hides empty categories", () => {
    const messages = [
      user("please look at @src/index.ts and fix it"),
      assistant([
        { type: "reasoning", text: "I will plan the change carefully here." },
        { type: "tool-Read", input: { file_path: "/a.ts" }, output: "file contents here" },
        { type: "tool-SendMessage", input: { to: "bob", text: "take this task" } },
      ]),
    ]
    const { rows, totalTokens } = buildContextSourceBreakdown(messages)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain("userMessages")
    expect(ids).toContain("mentionedFiles")
    expect(ids).toContain("thinking")
    expect(ids).toContain("toolOutputs")
    expect(ids).toContain("taskCoordination")
    // No system-prompt / claude-md row on the estimate path.
    expect(totalTokens).toBeGreaterThan(0)
  })

  it("separates coordination tools from real tool output", () => {
    const messages = [
      assistant([
        { type: "tool-TaskUpdate", input: { taskId: "t1", status: "done" } },
        { type: "tool-Bash", input: { command: "ls" }, output: "a b c" },
      ]),
    ]
    const { rows } = buildContextSourceBreakdown(messages)
    expect(rows.find((r) => r.id === "taskCoordination")?.tokens).toBeGreaterThan(0)
    expect(rows.find((r) => r.id === "toolOutputs")?.tokens).toBeGreaterThan(0)
  })

  it("sorts rows by descending token weight", () => {
    const messages = [
      user("a".repeat(400)),
      assistant([{ type: "reasoning", text: "b".repeat(40) }]),
    ]
    const { rows } = buildContextSourceBreakdown(messages)
    expect(rows[0].id).toBe("userMessages")
    expect(rows[0].tokens).toBeGreaterThanOrEqual(rows[1].tokens)
  })
})
