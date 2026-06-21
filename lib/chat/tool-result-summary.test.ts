import {
  coerceResultText,
  describeToolResult,
  diffCounts,
  resultErrorPreview,
} from "./tool-result-summary"
import type { ToolPartLike } from "./tool-summary"

function tool(
  type: string,
  extra: { input?: unknown; output?: unknown; errorText?: unknown; state?: string } = {}
): ToolPartLike {
  return {
    type,
    state: extra.state ?? "output-available",
    input: extra.input,
    output: extra.output,
    errorText: extra.errorText,
  } as unknown as ToolPartLike
}

describe("coerceResultText", () => {
  it("returns strings verbatim", () => {
    expect(coerceResultText("hello")).toBe("hello")
  })

  it("joins MCP content-block arrays by their text", () => {
    expect(
      coerceResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }, { foo: 1 }])
    ).toBe("a\nb")
  })

  it("JSON-stringifies plain objects", () => {
    expect(coerceResultText({ a: 1 })).toBe('{"a":1}')
  })

  it("returns empty string for nullish", () => {
    expect(coerceResultText(null)).toBe("")
    expect(coerceResultText(undefined)).toBe("")
  })

  it("JSON-stringifies an array with no text blocks (not joined)", () => {
    expect(coerceResultText([{ foo: 1 }, 2])).toBe('[{"foo":1},2]')
  })

  it("falls back to String() when JSON.stringify throws (circular)", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(coerceResultText(circular)).toBe("[object Object]")
  })
})

describe("diffCounts", () => {
  it("counts new_string added / old_string removed for edit", () => {
    expect(diffCounts("edit", { old_string: "a\nb", new_string: "x\ny\nz" })).toEqual({
      added: 3,
      removed: 2,
    })
  })

  it("counts all content lines as added for write (nothing removed)", () => {
    expect(diffCounts("write", { content: "l1\nl2" })).toEqual({ added: 2, removed: 0 })
  })

  it("treats an empty string as zero lines", () => {
    expect(diffCounts("edit", { old_string: "", new_string: "" })).toEqual({ added: 0, removed: 0 })
  })

  it("sums across MultiEdit edits", () => {
    expect(
      diffCounts("multiedit", {
        edits: [
          { old_string: "a", new_string: "b\nc" },
          { old_string: "d\ne", new_string: "f" },
          "garbage",
        ],
      })
    ).toEqual({ added: 3, removed: 3 })
  })

  it("returns zeros with no input", () => {
    expect(diffCounts("edit", undefined)).toEqual({ added: 0, removed: 0 })
  })

  it("covers the defensive fallbacks (missing / non-string / non-array fields)", () => {
    // write: content missing → new_string fallback; both missing → "".
    expect(diffCounts("write", { new_string: "a\nb" })).toEqual({ added: 2, removed: 0 })
    expect(diffCounts("write", {})).toEqual({ added: 0, removed: 0 })
    // multiedit: edits not an array → []; an edit missing both strings → zeros.
    expect(diffCounts("multiedit", { edits: "nope" })).toEqual({ added: 0, removed: 0 })
    expect(diffCounts("multiedit", { edits: [{}] })).toEqual({ added: 0, removed: 0 })
    // edit: missing or non-string old/new → "" via asString.
    expect(diffCounts("edit", {})).toEqual({ added: 0, removed: 0 })
    expect(diffCounts("edit", { old_string: 5, new_string: 6 })).toEqual({ added: 0, removed: 0 })
  })
})

describe("resultErrorPreview", () => {
  it("returns the first non-blank line, trimmed", () => {
    expect(resultErrorPreview("\n\n  boom happened  \nmore")).toBe("boom happened")
  })

  it("clamps to max with an ellipsis", () => {
    expect(resultErrorPreview("x".repeat(100), 10)).toBe("xxxxxxxxx…")
  })
})

describe("describeToolResult", () => {
  it("summarizes grep output as matches", () => {
    expect(describeToolResult(tool("tool-Grep", { output: "a\nb\n\nc" }))).toEqual({
      kind: "matches",
      count: 3,
      tone: "neutral",
    })
  })

  it("summarizes glob output as files and ls as entries", () => {
    expect(describeToolResult(tool("tool-Glob", { output: "x\ny" }))?.kind).toBe("files")
    expect(describeToolResult(tool("tool-ls", { output: "x\ny\nz" }))).toMatchObject({
      kind: "entries",
      count: 3,
    })
  })

  it("summarizes read/bash output as raw line count", () => {
    expect(describeToolResult(tool("tool-Read", { output: "l1\nl2\nl3" }))).toMatchObject({
      kind: "lines",
      count: 3,
    })
    expect(describeToolResult(tool("tool-Bash", { output: "one line" }))?.kind).toBe("lines")
  })

  it("summarizes diff tools from the input once completed", () => {
    expect(
      describeToolResult(tool("tool-Edit", { input: { old_string: "a", new_string: "b\nc" } }))
    ).toEqual({ kind: "diff", added: 2, removed: 1, tone: "success" })
  })

  it("folds namespaced mcp diff tools too", () => {
    expect(
      describeToolResult(
        tool("tool-mcp__cognia-tools__edit", { input: { old_string: "a", new_string: "b" } })
      )?.kind
    ).toBe("diff")
  })

  it("returns null for a diff tool with no net change", () => {
    expect(
      describeToolResult(tool("tool-Edit", { input: { old_string: "", new_string: "" } }))
    ).toBeNull()
  })

  it("shows the first error line for errored tools regardless of type", () => {
    expect(
      describeToolResult(tool("tool-Bash", { state: "output-error", errorText: "exit 1\ntrace" }))
    ).toEqual({ kind: "error", preview: "exit 1", tone: "error" })
  })

  it("falls back to output for an error with no errorText", () => {
    expect(
      describeToolResult(tool("tool-Read", { state: "output-error", output: "ENOENT" }))?.preview
    ).toBe("ENOENT")
  })

  it("returns null while still streaming (no output yet)", () => {
    expect(describeToolResult(tool("tool-Grep", { state: "input-available" }))).toBeNull()
    expect(describeToolResult(tool("tool-Edit", { state: "input-available" }))).toBeNull()
  })

  it("returns null for tools with no natural summary", () => {
    expect(describeToolResult(tool("tool-WebSearch", { output: "stuff" }))).toBeNull()
  })

  it("returns null when output is empty", () => {
    expect(describeToolResult(tool("tool-Grep", { output: "" }))).toBeNull()
  })
})
