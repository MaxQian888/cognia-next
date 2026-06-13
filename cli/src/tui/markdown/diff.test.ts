/**
 * @jest-environment node
 */
import { diffFilePath, formatEditDiff, highlightDiffText } from "./diff"
import { langFromPath, stripAnsi } from "./highlight"
import type { DiffLine } from "./types"

const COLORS = { add: "green", del: "red", context: "gray" }

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

describe("diffFilePath", () => {
  it("reads the snake_case, camelCase, and bare path aliases", () => {
    expect(diffFilePath({ file_path: "/a.ts" })).toBe("/a.ts")
    expect(diffFilePath({ filePath: "/b.ts" })).toBe("/b.ts")
    expect(diffFilePath({ path: "/c.ts" })).toBe("/c.ts")
    expect(diffFilePath({})).toBeUndefined()
  })
})

describe("langFromPath (used to infer the diff language)", () => {
  it("maps a .ts file to typescript", () => {
    expect(langFromPath("/src/a.ts")).toBe("typescript")
  })

  it("is case-insensitive and handles Windows separators", () => {
    expect(langFromPath("C:\\src\\App.PY")).toBe("python")
  })

  it("returns undefined for unknown or extensionless paths", () => {
    expect(langFromPath("/src/LICENSE")).toBeUndefined()
    expect(langFromPath("/src/data.unknownext")).toBeUndefined()
  })
})

describe("highlightDiffText", () => {
  const TS_KEYWORD = "[34m" // cli-highlight colours the `const` keyword blue
  const ADD = "[32m" // green (diffColors.add)
  const ESC = TS_KEYWORD.slice(0, 1) // the ANSI escape byte, reused from above
  const DEL = `${ESC}[31m` // red (diffColors.del)
  const MUTED = `${ESC}[90m` // gray (diffColors.context)

  it("highlights a TS add line AND tints it with the add colour (role wins on conflict)", () => {
    // `cli-highlight` colours via chalk, which is a no-op passthrough under the
    // Jest mock — so stub it to emit a real keyword colour and assert the
    // renderer (a) keeps that highlight code and (b) wraps it with the role tint.
    jest.isolateModules(() => {
      jest.doMock("cli-highlight", () => ({
        supportsLanguage: () => true,
        highlight: (code: string) => code.replace("const", `${TS_KEYWORD}const${ESC}[39m`),
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a sync re-require under the mock
      const { highlightDiffText: hdt } = require("./diff") as typeof import("./diff")
      const line: DiffLine = { kind: "add", text: "const x = 1", newNo: 1 }
      const out = hdt(line, langFromPath("/a.ts"), COLORS)
      // syntax highlight is present (the `const` keyword colour) …
      expect(out).toContain(TS_KEYWORD)
      // … and so is the add (role) colour, applied as the outer tint …
      expect(out).toContain(ADD)
      // … with the role colour opening the string so it wins where highlight stays default.
      expect(out.startsWith(ADD)).toBe(true)
      // text content is preserved exactly.
      expect(stripAnsi(out)).toBe("const x = 1")
    })
    jest.dontMock("cli-highlight")
  })

  it("tints a del line red without highlighting when no language is inferable", () => {
    const line: DiffLine = { kind: "del", text: "const x = 1", oldNo: 1 }
    const out = highlightDiffText(line, undefined, COLORS)
    expect(out).toContain(DEL) // red role colour
    expect(out).not.toContain("[34m") // no syntax highlight
    expect(stripAnsi(out)).toBe("const x = 1")
  })

  it("tints context lines with the muted colour", () => {
    const line: DiffLine = { kind: "context", text: "plain", newNo: 1, oldNo: 1 }
    const out = highlightDiffText(line, "typescript", COLORS)
    expect(out).toContain(MUTED) // gray (muted)
    expect(stripAnsi(out)).toBe("plain")
  })

  it("tints a meta line without highlighting", () => {
    const line: DiffLine = { kind: "meta", text: "/a.ts" }
    const out = highlightDiffText(line, "typescript", COLORS)
    expect(out).toContain(MUTED)
    expect(out).not.toContain("[34m")
    expect(stripAnsi(out)).toBe("/a.ts")
  })
})
