/**
 * @jest-environment node
 */
import { collectInspectables } from "./inspect"
import type { Cell } from "../state/types"

const toolCell = (id: string, toolName: string, over: Partial<Cell> = {}): Cell =>
  ({
    id,
    kind: "tool",
    callKey: id,
    toolName,
    input: {},
    status: "done",
    result: "x",
    collapsed: true,
    ...over,
  }) as Cell

describe("collectInspectables", () => {
  it("returns tool/bash cells with output, newest first", () => {
    const cells: Cell[] = [
      toolCell("1", "read", { input: { file_path: "/a.ts" }, result: "code" }),
      { id: "2", kind: "bash", command: "ls", output: "a\nb", status: "done" },
      toolCell("3", "grep", { input: { pattern: "x" }, result: "hit" }),
    ]
    const items = collectInspectables(cells)
    expect(items.map((i) => i.cellId)).toEqual(["3", "2", "1"])
  })

  it("skips tool cells with no result and bash cells with no output", () => {
    const cells: Cell[] = [
      toolCell("1", "read", { result: undefined, status: "running" }),
      { id: "2", kind: "bash", command: "sleep", output: "", status: "running" },
      toolCell("3", "read", { input: { file_path: "/a.ts" }, result: "code" }),
    ]
    expect(collectInspectables(cells).map((i) => i.cellId)).toEqual(["3"])
  })

  it("ignores non-tool/bash cells (assistant, user, notice)", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "hi" },
      { id: "2", kind: "assistant", raw: "reply" },
      { id: "3", kind: "notice", message: "note" },
    ]
    expect(collectInspectables(cells)).toEqual([])
  })

  it("labels a read with its path summary and an error tool with ✗", () => {
    const items = collectInspectables([
      toolCell("1", "read", { input: { file_path: "/a.ts" }, result: "code\nmore" }),
      toolCell("2", "bash", { input: { command: "boom" }, result: "err", isError: true }),
    ])
    const read = items.find((i) => i.cellId === "1")!
    expect(read.label).toContain("Read")
    expect(read.summary).toBe("/a.ts")
    expect(read.lines).toBe(2)
    const errored = items.find((i) => i.cellId === "2")!
    expect(errored.label).toContain("✗")
    expect(errored.isError).toBe(true)
  })

  it("labels a bash shell-out with its command", () => {
    const items = collectInspectables([
      { id: "1", kind: "bash", command: "git status", output: "clean", status: "done" },
    ])
    expect(items[0].label).toBe("! git status")
    expect(items[0].summary).toBe("shell")
  })
})
