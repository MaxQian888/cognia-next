/**
 * @jest-environment node
 */
import { isDiffTool, isTodoTool, parseTodos, summarizeToolCall } from "./tools"

describe("isDiffTool", () => {
  it("recognizes file-editing tools case-insensitively", () => {
    expect(isDiffTool("Edit")).toBe(true)
    expect(isDiffTool("multi_edit")).toBe(true)
    expect(isDiffTool("bash")).toBe(false)
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
