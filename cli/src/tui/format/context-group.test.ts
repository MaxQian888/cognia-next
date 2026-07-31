/**
 * @jest-environment node
 */
import { groupContextRuns, isContextTool, summarizeContextGroup } from "./context-group"
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
