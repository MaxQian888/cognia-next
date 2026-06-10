/**
 * @jest-environment node
 */
import { formatEditDiff } from "./diff"

describe("formatEditDiff", () => {
  it("renders an edit as a meta header plus del/add lines", () => {
    const lines = formatEditDiff("edit", {
      file_path: "/a.ts",
      old_string: "old1\nold2",
      new_string: "new1",
    })
    expect(lines[0]).toEqual({ kind: "meta", text: "/a.ts" })
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(2)
    expect(lines.filter((l) => l.kind === "add")).toHaveLength(1)
  })

  it("renders a write as all-add content", () => {
    const lines = formatEditDiff("write", { file_path: "/b.ts", content: "line1\nline2" })
    expect(lines[0]).toEqual({ kind: "meta", text: "/b.ts" })
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["line1", "line2"])
  })

  it("renders a multi_edit as sequential del/add pairs", () => {
    const lines = formatEditDiff("multi_edit", {
      file_path: "/c.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
        "garbage",
      ],
    })
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["a", "c"])
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["b", "d"])
  })

  it("supports camelCase field aliases for str_replace", () => {
    const lines = formatEditDiff("str_replace", { path: "/d.ts", oldString: "x", newString: "y" })
    expect(lines).toEqual([
      { kind: "meta", text: "/d.ts" },
      { kind: "del", text: "x", oldNo: 1 },
      { kind: "add", text: "y", newNo: 1 },
    ])
  })

  it("renders a create tool with the contents alias", () => {
    const lines = formatEditDiff("create", { file_path: "/e.ts", contents: "x" })
    expect(lines).toEqual([
      { kind: "meta", text: "/e.ts" },
      { kind: "add", text: "x", newNo: 1 },
    ])
  })

  it("numbers del lines on the old side and add lines on the new side", () => {
    const lines = formatEditDiff("edit", {
      file_path: "/a.ts",
      old_string: "old1\nold2",
      new_string: "new1",
    })
    expect(lines.filter((l) => l.kind === "del").map((l) => l.oldNo)).toEqual([1, 2])
    expect(lines.filter((l) => l.kind === "add").map((l) => l.newNo)).toEqual([1])
    // meta header carries no line numbers.
    expect(lines[0].oldNo).toBeUndefined()
  })

  it("numbers multi_edit lines cumulatively across hunks", () => {
    const lines = formatEditDiff("multi_edit", {
      file_path: "/c.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    })
    expect(lines.filter((l) => l.kind === "del").map((l) => l.oldNo)).toEqual([1, 2])
    expect(lines.filter((l) => l.kind === "add").map((l) => l.newNo)).toEqual([1, 2])
  })

  it("renders a write with no content as just the meta header", () => {
    expect(formatEditDiff("write", { file_path: "/f.ts" })).toEqual([
      { kind: "meta", text: "/f.ts" },
    ])
  })

  it("returns an empty list when no recognizable fields are present", () => {
    expect(formatEditDiff("edit", {})).toEqual([])
  })
})
