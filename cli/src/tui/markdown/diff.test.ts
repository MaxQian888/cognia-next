/**
 * @jest-environment node
 */
import {
  bareToolName,
  diffFilePath,
  formatEditDiff,
  highlightDiffText,
  tailDiffPreview,
} from "./diff"
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

  it("renders a namespaced cognia write (ai-sdk path) as all-add content", () => {
    const lines = formatEditDiff("mcp__cognia-tools__write", {
      file_path: "/b.ts",
      content: "line1\nline2",
    })
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

describe("bareToolName", () => {
  it("strips the mcp/plugin namespace to the bare tool name", () => {
    expect(bareToolName("mcp__cognia-tools__edit")).toBe("edit")
    expect(bareToolName("mcp__cognia-tools__git_status")).toBe("git_status")
    expect(bareToolName("plugin__my-plugin__write")).toBe("write")
  })

  it("returns un-namespaced names unchanged", () => {
    expect(bareToolName("Edit")).toBe("Edit")
    expect(bareToolName("bash")).toBe("bash")
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

describe("tailDiffPreview", () => {
  const body = (n: number): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "add" as const, text: `l${i}`, newNo: i + 1 }))

  it("returns the diff unchanged when it fits", () => {
    const diff: DiffLine[] = [{ kind: "meta", text: "/a.ts" }, ...body(3)]
    const out = tailDiffPreview(diff, 50)
    expect(out.lines).toBe(diff)
    expect(out.hidden).toBe(0)
  })

  it("keeps the meta header and the last `max` body lines", () => {
    const diff: DiffLine[] = [{ kind: "meta", text: "/a.ts" }, ...body(60)]
    const out = tailDiffPreview(diff, 50)
    expect(out.hidden).toBe(10)
    expect(out.lines[0]).toEqual({ kind: "meta", text: "/a.ts" })
    expect(out.lines).toHaveLength(51)
    // The tail survives: the newest lines of a big write/edit are what remains.
    expect(out.lines[out.lines.length - 1].text).toBe("l59")
    expect(out.lines.some((l) => l.text === "l9")).toBe(false)
  })

  it("handles a diff with no meta line", () => {
    const out = tailDiffPreview(body(60), 10)
    expect(out.hidden).toBe(50)
    expect(out.lines).toHaveLength(10)
    expect(out.lines[0].text).toBe("l50")
  })

  it("treats an all-meta diff as untruncatable", () => {
    const diff: DiffLine[] = [{ kind: "meta", text: "/a.ts" }]
    const out = tailDiffPreview(diff, 1)
    expect(out.hidden).toBe(0)
    expect(out.lines).toHaveLength(1)
  })
})

describe("highlightDiffText", () => {
  const TS_KEYWORD = "[34m" // cli-highlight colours the `const` keyword blue
  const ADD = "[32m" // green (diffColors.add)
  const ESC = TS_KEYWORD.slice(0, 1) // the ANSI escape byte, reused from above
  const DEL = `${ESC}[31m` // red (diffColors.del)
  const MUTED = `${ESC}[90m` // gray (diffColors.context)

  it("shows the full syntax highlight WITHOUT a diff-role tint (sign column carries add/del)", () => {
    // `cli-highlight` colours via chalk, which is a no-op passthrough under the
    // Jest mock — so stub it to emit a real keyword colour and assert the
    // renderer keeps that highlight and does NOT flatten the line with the role tint.
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
      // … and the diff-role (add/green) colour is NOT applied to the body — the
      // marker/gutter in DiffView carry it instead, so the highlight shows.
      expect(out).not.toContain(ADD)
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

  it("tints context lines with the muted colour when no language is inferable", () => {
    const line: DiffLine = { kind: "context", text: "plain", newNo: 1, oldNo: 1 }
    const out = highlightDiffText(line, undefined, COLORS)
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
