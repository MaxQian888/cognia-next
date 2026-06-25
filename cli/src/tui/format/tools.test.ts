/**
 * @jest-environment node
 */
import {
  diffStat,
  isDiffTool,
  isTodoTool,
  parseTodos,
  resultCountLabel,
  resultPreview,
  runningToolLines,
  summarizeResult,
  summarizeToolCall,
  toolDetailLine,
  toolDisplayName,
  toolKind,
} from "./tools"
import type { ToolCell } from "../state/types"

const toolCell = (over: Partial<ToolCell> = {}): ToolCell => ({
  id: "t1",
  kind: "tool",
  callKey: "k1",
  toolName: "bash",
  input: { command: "npm test" },
  status: "running",
  collapsed: true,
  ...over,
})

describe("isDiffTool", () => {
  it("recognizes file-editing tools case-insensitively", () => {
    expect(isDiffTool("Edit")).toBe(true)
    expect(isDiffTool("multi_edit")).toBe(true)
    expect(isDiffTool("bash")).toBe(false)
  })

  it("recognizes namespaced cognia edit/write tools (the ai-sdk path)", () => {
    expect(isDiffTool("mcp__cognia-tools__edit")).toBe(true)
    expect(isDiffTool("mcp__cognia-tools__write")).toBe(true)
    expect(isDiffTool("mcp__cognia-tools__bash")).toBe(false)
  })
})

describe("isTodoTool", () => {
  it("matches TodoWrite case-insensitively", () => {
    expect(isTodoTool("TodoWrite")).toBe(true)
    expect(isTodoTool("todowrite")).toBe(true)
    expect(isTodoTool("write")).toBe(false)
  })
})

describe("parseTodos", () => {
  it("parses well-formed todos and defaults invalid status to pending", () => {
    const todos = parseTodos({
      todos: [
        { content: "a", status: "in_progress", activeForm: "Doing a" },
        { content: "b", status: "weird" },
      ],
    })
    expect(todos).toEqual([
      { content: "a", status: "in_progress", activeForm: "Doing a" },
      { content: "b", status: "pending" },
    ])
  })

  it("skips entries without string content and tolerates non-objects", () => {
    expect(parseTodos({ todos: [{ status: "pending" }, "x", null, { content: "" }] })).toEqual([])
  })

  it("returns [] for non-object or missing todos", () => {
    expect(parseTodos(null)).toEqual([])
    expect(parseTodos({})).toEqual([])
    expect(parseTodos({ todos: "nope" })).toEqual([])
  })
})

describe("summarizeToolCall", () => {
  it("summarizes bash by command", () => {
    expect(summarizeToolCall("bash", { command: "ls -la" })).toBe("ls -la")
  })

  it("summarizes grep by pattern and path", () => {
    expect(summarizeToolCall("grep", { pattern: "foo", path: "src" })).toBe("foo  src")
  })

  it("summarizes glob by pattern", () => {
    expect(summarizeToolCall("glob", { pattern: "**/*.ts" })).toBe("**/*.ts")
  })

  it("summarizes file tools by path", () => {
    expect(summarizeToolCall("read", { file_path: "/a.ts" })).toBe("/a.ts")
  })

  it("appends a read line range when offset/limit are present", () => {
    expect(summarizeToolCall("read", { file_path: "/a.ts", offset: 10, limit: 40 })).toBe(
      "/a.ts :10-50"
    )
    expect(summarizeToolCall("read", { file_path: "/a.ts", offset: 10 })).toBe("/a.ts :10+")
    expect(summarizeToolCall("read", { file_path: "/a.ts", limit: 40 })).toBe("/a.ts :0-40")
  })

  it("returns '' for a read with no path", () => {
    expect(summarizeToolCall("read", { offset: 1 })).toBe("")
  })

  it("summarizes web fetches by url", () => {
    expect(summarizeToolCall("web_fetch", { url: "https://x.dev" })).toBe("https://x.dev")
    expect(summarizeToolCall("WebFetch", { uri: "https://y.dev" })).toBe("https://y.dev")
  })

  it("summarizes subagent dispatch by type/description", () => {
    expect(summarizeToolCall("task", { subagent_type: "Explore" })).toBe("Explore")
    expect(summarizeToolCall("dispatch_agent", { description: "find files" })).toBe("find files")
  })

  it("summarizes apply_patch by the number of files it touches", () => {
    const patch =
      "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n+d\n"
    expect(summarizeToolCall("apply_patch", { patch })).toBe("2 files")
    expect(
      summarizeToolCall("apply_patch", { patch: "--- /dev/null\n+++ z.ts\n@@ -0,0 +1 @@\n+a\n" })
    ).toBe("1 file")
    expect(summarizeToolCall("apply_patch", { patch: "" })).toBe("")
  })

  it("truncates long values with an ellipsis", () => {
    const long = "x".repeat(200)
    const out = summarizeToolCall("bash", { command: long })
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(80)
  })

  it("returns '' when no known field is present", () => {
    expect(summarizeToolCall("unknown", {})).toBe("")
  })
})

describe("toolDetailLine", () => {
  it("builds '└ <tool>: <summary>' for a bash tool", () => {
    expect(toolDetailLine(toolCell({ toolName: "bash", input: { command: "npm test" } }))).toBe(
      "└ bash: npm test"
    )
  })

  it("uses the file path for a read tool", () => {
    expect(toolDetailLine(toolCell({ toolName: "read", input: { file_path: "/a/b.ts" } }))).toBe(
      "└ read: /a/b.ts"
    )
  })

  it("collapses an MCP tool name to <server>:<tool>", () => {
    const line = toolDetailLine(toolCell({ toolName: "mcp__github__create_issue", input: {} }))
    expect(line).toBe("└ github:create_issue")
  })

  it("drops the summary tail when there is no natural summary", () => {
    expect(toolDetailLine(toolCell({ toolName: "noop", input: {} }))).toBe("└ noop")
  })

  it("truncates to the column budget with an ellipsis", () => {
    const line = toolDetailLine(
      toolCell({ toolName: "bash", input: { command: "a".repeat(100) } }),
      20
    )
    expect(line.endsWith("…")).toBe(true)
    // "└ " + content fits within 20 display columns.
    expect(line.length).toBeLessThanOrEqual(20)
  })

  it("counts CJK summaries as double-width when truncating", () => {
    const line = toolDetailLine(
      toolCell({ toolName: "bash", input: { command: "中".repeat(20) } }),
      12
    )
    // Each 中 is 2 columns; the line must not exceed the 12-column budget.
    let w = 0
    for (const ch of line) w += /\p{Script=Han}/u.test(ch) ? 2 : 1
    expect(w).toBeLessThanOrEqual(12)
  })
})

describe("runningToolLines", () => {
  it("returns only running tools, most-recent last, capped at max", () => {
    const tools: ToolCell[] = [
      toolCell({ id: "1", toolName: "read", input: { file_path: "/a" }, status: "done" }),
      toolCell({ id: "2", toolName: "bash", input: { command: "one" }, status: "running" }),
      toolCell({ id: "3", toolName: "bash", input: { command: "two" }, status: "running" }),
      toolCell({ id: "4", toolName: "bash", input: { command: "three" }, status: "running" }),
      toolCell({ id: "5", toolName: "bash", input: { command: "four" }, status: "running" }),
    ]
    const lines = runningToolLines(tools, 80, 3)
    expect(lines).toEqual(["└ bash: two", "└ bash: three", "└ bash: four"])
  })

  it("is empty when nothing is running", () => {
    expect(runningToolLines([toolCell({ status: "done" })])).toEqual([])
  })
})

describe("toolKind", () => {
  it("classifies by name prefix", () => {
    expect(toolKind("mcp__github__create_issue")).toBe("mcp")
    expect(toolKind("plugin__web-tools__fetch")).toBe("plugin")
    expect(toolKind("bash")).toBe("builtin")
  })
})

describe("toolDisplayName", () => {
  it("collapses mcp and plugin names to source:tool", () => {
    expect(toolDisplayName("mcp__github__create_issue")).toBe("github:create_issue")
    expect(toolDisplayName("plugin__web-tools__fetch")).toBe("web-tools:fetch")
  })

  it("leaves builtins unchanged", () => {
    expect(toolDisplayName("bash")).toBe("bash")
    expect(toolDisplayName("Read")).toBe("Read")
  })
})

describe("diffStat", () => {
  it("counts added and removed lines for an edit", () => {
    expect(
      diffStat("edit", { file_path: "/a.ts", old_string: "a\nb", new_string: "a\nc\nd" })
    ).toEqual({ added: 3, removed: 2 })
  })

  it("counts added lines for a write", () => {
    expect(diffStat("write", { file_path: "/a.ts", content: "one\ntwo\nthree" })).toEqual({
      added: 3,
      removed: 0,
    })
  })

  it("returns zeros for non-diff tools", () => {
    expect(diffStat("bash", { command: "ls" })).toEqual({ added: 0, removed: 0 })
  })
})

describe("summarizeResult", () => {
  it("measures a string result by lines and bytes", () => {
    expect(summarizeResult("a\nb\nc")).toEqual({ lines: 3, bytes: 5 })
  })

  it("measures an object result by its JSON length", () => {
    const size = summarizeResult({ ok: true })
    expect(size.bytes).toBe(JSON.stringify({ ok: true }).length)
    expect(size.lines).toBe(1)
  })

  it("returns zeros for null and empty results", () => {
    expect(summarizeResult(null)).toEqual({ lines: 0, bytes: 0 })
    expect(summarizeResult("")).toEqual({ lines: 0, bytes: 0 })
  })
})

describe("resultPreview", () => {
  it("returns the first non-blank line", () => {
    expect(resultPreview("\n\nError: boom\ndetails")).toBe("Error: boom")
  })

  it("truncates a long line with an ellipsis", () => {
    const out = resultPreview("x".repeat(200), 20)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBe(20)
  })

  it("stringifies object results", () => {
    expect(resultPreview({ error: "nope" })).toBe('{"error":"nope"}')
  })

  it("returns '' for null or all-blank results", () => {
    expect(resultPreview(null)).toBe("")
    expect(resultPreview("   \n  ")).toBe("")
  })
})

describe("resultCountLabel", () => {
  it("counts grep matches and glob/ls entries (singular/plural)", () => {
    expect(resultCountLabel("grep", "a:1:x\nb:2:y\n")).toBe("2 matches")
    expect(resultCountLabel("grep", "only:1:x")).toBe("1 match")
    expect(resultCountLabel("glob", "a.ts\nb.ts\nc.ts")).toBe("3 files")
    expect(resultCountLabel("glob", "one.ts")).toBe("1 file")
    expect(resultCountLabel("ls", "a\nb")).toBe("2 entries")
    expect(resultCountLabel("list", "x")).toBe("1 entry")
  })

  it("reads MCP content-block array results", () => {
    expect(resultCountLabel("grep", [{ type: "text", text: "x:1:a\ny:2:b" }])).toBe("2 matches")
  })

  it("returns undefined for tools without a natural count, and for empty results", () => {
    expect(resultCountLabel("bash", "some output")).toBeUndefined()
    expect(resultCountLabel("read", "file contents")).toBeUndefined()
    expect(resultCountLabel("grep", "")).toBeUndefined()
    expect(resultCountLabel("grep", null)).toBeUndefined()
  })
})
