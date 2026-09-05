/**
 * @jest-environment node
 */
import {
  toolResultPreviewText,
  diffStat,
  isDiffTool,
  isTodoTool,
  parseTodos,
  resultPreview,
  runningToolLines,
  summarizeResult,
  summarizeToolCall,
  toolDetailLine,
  toolDisplayName,
  toolGlyph,
  toolHeaderLabel,
  toolIconKey,
  humanizeToolName,
  toolFileLine,
  toolFilePath,
  toolKind,
} from "./tools"
import { stringWidth } from "../markdown/width"
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

describe("toolFilePath", () => {
  it("extracts the path for file tools by key precedence", () => {
    expect(toolFilePath("read", { file_path: "/a.ts" })).toBe("/a.ts")
    expect(toolFilePath("edit", { filePath: "/b.ts" })).toBe("/b.ts")
    expect(toolFilePath("grep", { path: "src" })).toBe("src")
    expect(toolFilePath("read", { file_path: "/win.ts", path: "/other" })).toBe("/win.ts")
  })

  it("returns the verbatim (untruncated) path", () => {
    const long = "/" + "a".repeat(200) + ".ts"
    expect(toolFilePath("read", { file_path: long })).toBe(long)
  })

  it("recognises namespaced builtin edit tools", () => {
    expect(toolFilePath("mcp__cognia-tools__edit", { file_path: "/c.ts" })).toBe("/c.ts")
  })

  it("returns undefined for command tools and when no path is present", () => {
    expect(toolFilePath("bash", { command: "ls" })).toBeUndefined()
    expect(toolFilePath("shell", { command: "ls", path: "x" })).toBeUndefined()
    expect(toolFilePath("read", {})).toBeUndefined()
  })
})

describe("toolFileLine", () => {
  it("returns a read tool's offset as the line", () => {
    expect(toolFileLine("read", { file_path: "/a.ts", offset: 12 })).toBe(12)
  })

  it("returns undefined without an offset, for non-read tools, or offset 0", () => {
    expect(toolFileLine("read", { file_path: "/a.ts" })).toBeUndefined()
    expect(toolFileLine("read", { file_path: "/a.ts", offset: 0 })).toBeUndefined()
    expect(toolFileLine("edit", { file_path: "/a.ts", offset: 12 })).toBeUndefined()
  })
})

describe("summarizeToolCall", () => {
  it("shows terminal program, input, and target session in permission summaries", () => {
    expect(summarizeToolCall("terminal_repl_spawn", { shell: "node", args: ["-i"] })).toBe(
      "node -i"
    )
    expect(
      summarizeToolCall("mcp__cognia-tools__terminal_repl_write", {
        sessionId: "pty-1",
        data: "run()",
      })
    ).toBe("pty-1  run()")
    expect(summarizeToolCall("terminal_repl_kill", { sessionId: "pty-1", signal: "SIGTERM" })).toBe(
      "pty-1  SIGTERM"
    )
    expect(summarizeToolCall("terminal_repl_read", { sessionId: "pty-1" })).toBe("pty-1")
  })
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
      "└ Bash: npm test"
    )
  })

  it("uses the file path for a read tool", () => {
    expect(toolDetailLine(toolCell({ toolName: "read", input: { file_path: "/a/b.ts" } }))).toBe(
      "└ Read: /a/b.ts"
    )
  })

  it("collapses an MCP tool name to <server>:<tool>", () => {
    const line = toolDetailLine(toolCell({ toolName: "mcp__github__create_issue", input: {} }))
    expect(line).toBe("└ github:Create issue")
  })

  it("drops the summary tail when there is no natural summary", () => {
    expect(toolDetailLine(toolCell({ toolName: "noop", input: {} }))).toBe("└ Noop")
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
    expect(lines).toEqual(["└ Bash: two", "└ Bash: three", "└ Bash: four"])
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

describe("toolIconKey / toolGlyph", () => {
  it("buckets a tool the way the web row does, namespace and aliases included", () => {
    expect(toolIconKey("Read")).toBe("read")
    expect(toolIconKey("cat")).toBe("read")
    expect(toolIconKey("mcp__cognia-tools__grep")).toBe("search")
    expect(toolIconKey("plugin__web-tools__fetch")).toBe("web")
    expect(toolIconKey("MultiEdit")).toBe("edit")
    expect(toolIconKey("ls")).toBe("folder")
    expect(toolIconKey("todowrite")).toBe("task")
    expect(toolIconKey("something_unknown")).toBe("generic")
  })

  it("uses one-column glyphs, so a header's width math stays exact", () => {
    const keys = [
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "bash",
      "webfetch",
      "ls",
      "notebookedit",
      "todowrite",
      "unknown_tool",
    ]
    const glyphs = keys.map(toolGlyph)
    for (const glyph of glyphs) expect(stringWidth(glyph)).toBe(1)
    // Buckets must be visually distinguishable, not all the same glyph.
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })
})

describe("humanizeToolName / toolHeaderLabel", () => {
  it("titles a builtin and keeps an mcp namespace beside the humanized tool", () => {
    expect(humanizeToolName("bash")).toBe("Bash")
    expect(humanizeToolName("multi_edit")).toBe("Multi edit")
    expect(humanizeToolName("todoWrite")).toBe("Todo Write")
    expect(humanizeToolName("")).toBe("Tool")
    expect(toolHeaderLabel("read")).toBe("Read")
    expect(toolHeaderLabel("mcp__github__create_issue")).toBe("github:Create issue")
    expect(toolHeaderLabel("plugin__web-tools__fetch")).toBe("web-tools:Fetch")
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
    expect(resultPreview({ error: "nope" })).toBe("Error: nope")
  })

  it("returns '' for null or all-blank results", () => {
    expect(resultPreview(null)).toBe("")
    expect(resultPreview("   \n  ")).toBe("")
  })
})

it("formats structured results as labeled, bounded outlines", () => {
  expect(
    toolResultPreviewText({ exit_code: 0, stdout: "first\nsecond", files: ["a.ts", "b.ts"] })
  ).toBe("Exit code: 0\nStdout: first\n  second\nFiles:\n  a.ts\n  b.ts")
  expect(toolResultPreviewText({ content: [{ type: "text", text: "line one\nline two" }] })).toBe(
    "Content:\n  line one\n  line two"
  )
  expect(toolResultPreviewText(null)).toBe("")
  expect(toolResultPreviewText("raw\nsource")).toBe("raw\nsource")
  expect(toolResultPreviewText([null, true, 4, [], {}])).toBe("null\ntrue\n4\n(empty)\n(empty)")
  const cycle: Record<string, unknown> = { status: "ok" }
  cycle.self = cycle
  expect(toolResultPreviewText(cycle)).toContain("nested details — /expand")
  expect(toolResultPreviewText({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toContain(
    "nested details"
  )
  const wide = toolResultPreviewText(Array.from({ length: 1000 }, (_, i) => `file-${i}`))
  expect(wide.split("\n")).toHaveLength(121)
  expect(wide).toContain("structured preview — /expand")
})

it("includes alias read ranges, glob roots and generic actions", () => {
  expect(summarizeToolCall("cat", { path: "a.ts", offset: 2, limit: 3 })).toBe("a.ts :2-5")
  expect(summarizeToolCall("glob", { pattern: "*.ts", path: "src" })).toBe("*.ts  src")
  expect(summarizeToolCall("list", { cwd: "src" })).toBe("src")
  expect(summarizeToolCall("custom", { action: "restart" })).toBe("restart")
})
