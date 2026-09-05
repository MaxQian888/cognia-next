/**
 * @jest-environment node
 */
import {
  contextGroupLines,
  groupContextRuns,
  isContextTool,
  summarizeContextGroup,
} from "./context-group"
import type { Cell, ToolCell } from "../state/types"

const tool = (toolName: string, over: Partial<ToolCell> = {}): ToolCell => ({
  id: Math.random().toString(36).slice(2),
  kind: "tool",
  callKey: "k",
  toolName,
  input: {},
  status: "done",
  collapsed: true,
  ...over,
})

describe("isContextTool", () => {
  it("recognizes read/grep/glob/ls family, case-insensitively", () => {
    expect(isContextTool("Read")).toBe(true)
    expect(isContextTool("grep")).toBe(true)
    expect(isContextTool("glob")).toBe(true)
    expect(isContextTool("ls")).toBe(true)
    expect(isContextTool("bash")).toBe(false)
    expect(isContextTool("edit")).toBe(false)
  })
})

describe("isContextTool", () => {
  it("folds a namespaced builtin as readily as a bare one", () => {
    expect(isContextTool("Read")).toBe(true)
    expect(isContextTool("mcp__cognia-tools__grep")).toBe(true)
    expect(isContextTool("plugin__web-tools__list")).toBe(true)
    expect(isContextTool("bash")).toBe(false)
  })
})

describe("groupContextRuns", () => {
  it("folds an adjacent run of ≥2 completed context tools", () => {
    const cells: Cell[] = [tool("read"), tool("grep"), tool("glob")]
    const runs = groupContextRuns(cells, false)
    expect(runs).toHaveLength(1)
    expect(runs[0].kind).toBe("group")
  })

  it("leaves a lone context tool as its own row", () => {
    const runs = groupContextRuns([tool("read")], false)
    expect(runs).toEqual([{ kind: "single", cell: expect.objectContaining({ toolName: "read" }) }])
  })

  it("does not fold running or errored context tools, nor non-context tools", () => {
    const cells: Cell[] = [
      tool("read", { status: "running" }),
      tool("grep", { status: "error", isError: true }),
      tool("bash"),
    ]
    const runs = groupContextRuns(cells, false)
    expect(runs.every((r) => r.kind === "single")).toBe(true)
  })

  it("preserves order and splits runs around a non-context tool", () => {
    const cells: Cell[] = [
      tool("read"),
      tool("grep"),
      tool("edit"), // breaks the run
      tool("glob"),
      tool("ls"),
    ]
    const runs = groupContextRuns(cells, false)
    expect(runs.map((r) => r.kind)).toEqual(["group", "single", "group"])
  })

  it("disables folding entirely in verbose mode", () => {
    const cells: Cell[] = [tool("read"), tool("grep")]
    const runs = groupContextRuns(cells, true)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.kind === "single")).toBe(true)
  })
})

describe("summarizeContextGroup", () => {
  it("counts by category with singular/plural", () => {
    expect(summarizeContextGroup([tool("read"), tool("read"), tool("grep")])).toBe(
      "2 reads, 1 search"
    )
    expect(summarizeContextGroup([tool("glob"), tool("ls")])).toBe("1 glob, 1 list")
  })
})

it("counts namespaced tools by their actual action", () => {
  expect(
    summarizeContextGroup([tool("mcp__fs__read"), tool("plugin__fs__cat"), tool("mcp__fs__search")])
  ).toBe("2 reads, 1 search")
  expect(
    summarizeContextGroup([
      tool("glob"),
      tool("glob"),
      tool("ls"),
      tool("list"),
      tool("search"),
      tool("grep"),
    ])
  ).toBe("2 searches, 2 globs, 2 lists")
})

it("keeps explicitly expanded, cancelled and failed calls individually navigable", () => {
  const cells = [
    tool("read", { collapsed: false }),
    tool("read", { status: "cancelled" }),
    tool("read", { isError: true }),
  ]
  expect(groupContextRuns(cells, false)).toEqual(cells.map((cell) => ({ kind: "single", cell })))
})

it("shows bounded actions and targets without visiting result payloads", () => {
  const tools = Array.from({ length: 1000 }, (_, i) =>
    tool("read", { input: { path: `src/file-${i}.ts` } })
  )
  Object.defineProperty(tools[0], "result", {
    get: () => {
      throw new Error("must not scan results")
    },
  })
  const lines = contextGroupLines(tools)
  expect(lines).toHaveLength(5)
  expect(lines[0]).toBe("⚙ 1000 reads · done")
  expect(lines[1]).toBe("  Read: src/file-0.ts")
  expect(lines[4]).toBe("  +997 more · ctrl+o to expand")
})

it("bounds narrow rows and sanitizes targets, including missing inputs", () => {
  expect(contextGroupLines([tool("ls")])[1]).toContain("no target supplied")
  const lines = contextGroupLines(
    [tool("grep", { input: { pattern: "find\nthis", path: "src/" } })],
    24
  )
  expect(lines.join("\n")).toContain("find this")
  expect(lines.every((line) => line.length <= 24)).toBe(true)
  expect(contextGroupLines([], 1)).toEqual(["…"])
})
