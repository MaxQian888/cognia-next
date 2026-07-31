import {
  hasMcpContent,
  isSubagentPart,
  type McpResultBlock,
  type SubagentPart,
} from "./parts-extensions"

describe("parts-extensions — hasMcpContent (gap3)", () => {
  it("returns true when mcpContent is a non-empty array", () => {
    const blocks: McpResultBlock[] = [{ type: "image", data: "AAAA", mimeType: "image/png" }]
    expect(hasMcpContent({ type: "tool-x", mcpContent: blocks })).toBe(true)
  })

  it("returns false for an empty array, missing field, or non-array", () => {
    expect(hasMcpContent({ type: "tool-x", mcpContent: [] })).toBe(false)
    expect(hasMcpContent({ type: "tool-x" })).toBe(false)
    expect(hasMcpContent({ type: "tool-x", mcpContent: "nope" })).toBe(false)
    expect(hasMcpContent(null)).toBe(false)
  })
})

describe("parts-extensions — isSubagentPart forward-compat (gap7)", () => {
  it("still accepts a part carrying the new terminal-snapshot fields", () => {
    const part: SubagentPart = {
      type: "subagent",
      subagentId: "sa-1",
      parentSessionId: "sess-1",
      name: "researcher",
      status: "completed",
      progress: 100,
      startedAt: 0,
      // new snapshot fields
      toolCalls: [{ id: "c1", name: "read", state: "done" }],
      logs: [{ level: "info", message: "done" }],
      finalResponse: "all set",
      toolUses: 3,
    }
    expect(isSubagentPart(part)).toBe(true)
  })

  it("rejects non-subagent shapes", () => {
    expect(isSubagentPart({ type: "subagent" })).toBe(false)
    expect(isSubagentPart({ type: "text", subagentId: "x" })).toBe(false)
    expect(isSubagentPart(null)).toBe(false)
  })
})
