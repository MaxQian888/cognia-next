/** @jest-environment node */
import {
  coerceResultText,
  describeToolResult,
  describeRunningProgress,
  formatResultDescriptor,
  isDetailDescriptor,
} from "./tool-result"
import type { ToolCell } from "../state/types"

function tool(overrides: Partial<ToolCell> & Pick<ToolCell, "toolName" | "status">): ToolCell {
  return {
    id: "t",
    kind: "tool",
    callKey: "k",
    input: {},
    collapsed: true,
    ...overrides,
  }
}

describe("coerceResultText", () => {
  it("reads strings, MCP content blocks and objects", () => {
    expect(coerceResultText("plain")).toBe("plain")
    expect(coerceResultText([{ type: "text", text: "a" }, { type: "image" }, { text: "b" }])).toBe(
      "a\nb"
    )
    expect(coerceResultText({ ok: true })).toBe('{"ok":true}')
    expect(coerceResultText(null)).toBe("")
  })
})

describe("describeToolResult", () => {
  it("counts grep matches, glob files and ls entries by non-blank line", () => {
    expect(
      describeToolResult(tool({ toolName: "grep", status: "done", result: "a:1:x\nb:2:y\n" }))
    ).toEqual({ kind: "matches", count: 2, tone: "neutral" })
    expect(
      describeToolResult(tool({ toolName: "glob", status: "done", result: "one.ts" }))
    ).toEqual({ kind: "files", count: 1, tone: "neutral" })
    expect(describeToolResult(tool({ toolName: "ls", status: "done", result: "a\nb" }))).toEqual({
      kind: "entries",
      count: 2,
      tone: "neutral",
    })
  })

  it("falls back to a raw line count so no settled call is left without a size", () => {
    expect(
      describeToolResult(tool({ toolName: "git_status", status: "done", result: "a\nb\nc" }))
    ).toEqual({ kind: "lines", count: 3, tone: "neutral" })
  })

  it("folds an mcp namespace before classifying, like the web summarizer", () => {
    expect(
      describeToolResult(
        tool({ toolName: "mcp__cognia-tools__grep", status: "done", result: "a\nb" })
      )
    ).toEqual({ kind: "matches", count: 2, tone: "neutral" })
  })

  it("summarizes a diff from the input as soon as the call starts", () => {
    const running = tool({
      toolName: "edit",
      status: "running",
      input: { file_path: "/a.ts", old_string: "x", new_string: "y\nz" },
    })
    expect(describeToolResult(running)).toEqual({
      kind: "diff",
      added: 2,
      removed: 1,
      tone: "success",
    })
  })

  it("puts a failure first, whatever the tool", () => {
    const failed = tool({
      toolName: "edit",
      status: "error",
      input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      result: "\nError: file is read-only\nstack",
      isError: true,
    })
    expect(describeToolResult(failed)).toEqual({
      kind: "error",
      preview: "Error: file is read-only",
      tone: "error",
    })
  })

  it("stays silent while a non-diff call is unsettled or empty", () => {
    expect(describeToolResult(tool({ toolName: "read", status: "running" }))).toBeNull()
    expect(describeToolResult(tool({ toolName: "read", status: "cancelled" }))).toBeNull()
    expect(describeToolResult(tool({ toolName: "read", status: "done" }))).toBeNull()
    expect(describeToolResult(tool({ toolName: "read", status: "done", result: "" }))).toBeNull()
  })
})

describe("formatResultDescriptor", () => {
  it("pluralizes every count and renders a diff as +/-", () => {
    expect(formatResultDescriptor({ kind: "matches", count: 1, tone: "neutral" })).toBe("1 match")
    expect(formatResultDescriptor({ kind: "matches", count: 2, tone: "neutral" })).toBe("2 matches")
    expect(formatResultDescriptor({ kind: "files", count: 1, tone: "neutral" })).toBe("1 file")
    expect(formatResultDescriptor({ kind: "entries", count: 1, tone: "neutral" })).toBe("1 entry")
    expect(formatResultDescriptor({ kind: "entries", count: 3, tone: "neutral" })).toBe("3 entries")
    expect(formatResultDescriptor({ kind: "lines", count: 1, tone: "neutral" })).toBe("1 line")
    expect(formatResultDescriptor({ kind: "diff", added: 5, removed: 2, tone: "success" })).toBe(
      "+5 -2"
    )
    expect(formatResultDescriptor({ kind: "diff", added: 5, removed: 0, tone: "success" })).toBe(
      "+5"
    )
    expect(formatResultDescriptor({ kind: "error", preview: "boom", tone: "error" })).toBe("boom")
  })
})

describe("isDetailDescriptor", () => {
  it("routes only a failure to the detail line under the header", () => {
    expect(isDetailDescriptor({ kind: "error", preview: "boom", tone: "error" })).toBe(true)
    expect(isDetailDescriptor({ kind: "lines", count: 2, tone: "neutral" })).toBe(false)
  })
})

describe("describeRunningProgress", () => {
  it("measures streamed output only while the call is in flight", () => {
    expect(
      describeRunningProgress(tool({ toolName: "bash", status: "running", result: "a\nb" }))
    ).toEqual({ lines: 2, bytes: 3 })
    expect(describeRunningProgress(tool({ toolName: "bash", status: "running" }))).toBeNull()
    expect(
      describeRunningProgress(tool({ toolName: "bash", status: "done", result: "a" }))
    ).toBeNull()
  })
})
