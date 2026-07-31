/**
 * @jest-environment node
 */
import { renderResultLines, resultToText, toolResultLang } from "./result-render"
import { stripAnsi } from "../markdown/highlight"
import { BUILTIN_THEMES } from "../theme/builtins"

describe("toolResultLang", () => {
  it("infers a file language from a read tool's path", () => {
    expect(toolResultLang("read", { file_path: "/a/b/foo.ts" })).toBe("typescript")
    expect(toolResultLang("read", { path: "x/y.py" })).toBe("python")
  })

  it("returns bash for shell tools and powershell for pwsh", () => {
    expect(toolResultLang("bash", { command: "ls" })).toBe("bash")
    expect(toolResultLang("shell", {})).toBe("bash")
    expect(toolResultLang("powershell", {})).toBe("powershell")
    expect(toolResultLang("pwsh", {})).toBe("powershell")
  })

  it("falls back to a path-like field for unknown tools", () => {
    expect(toolResultLang("mcp__fs__read", { file_path: "z.rs" })).toBe("rust")
  })

  it("returns undefined when no language can be inferred", () => {
    expect(toolResultLang("grep", { pattern: "x" })).toBeUndefined()
    expect(toolResultLang("read", { file_path: "/no/extension" })).toBeUndefined()
  })
})

describe("renderResultLines", () => {
  it("returns empty for empty input", () => {
    expect(renderResultLines("")).toEqual({ lines: [], hiddenLines: 0, totalLines: 0 })
  })

  it("preserves text content when highlighting (only ANSI added)", () => {
    const code = "const x = 1\nconst y = 2"
    const r = renderResultLines(code, {
      lang: "typescript",
      highlight: true,
      palette: BUILTIN_THEMES.dark,
    })
    expect(r.totalLines).toBe(2)
    expect(r.lines.map((l) => stripAnsi(l))).toEqual(["const x = 1", "const y = 2"])
  })

  it("does not highlight when disabled, leaving text verbatim", () => {
    const r = renderResultLines("a\nb", { lang: "typescript", highlight: false })
    expect(r.lines).toEqual(["a", "b"])
  })

  it("prefixes 1-based line numbers when requested", () => {
    const r = renderResultLines("alpha\nbeta", { lineNumbers: true, highlight: false })
    expect(stripAnsi(r.lines[0])).toBe("1 │ alpha")
    expect(stripAnsi(r.lines[1])).toBe("2 │ beta")
  })

  it("right-aligns line-number gutter to the total width", () => {
    const text = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join("\n")
    const r = renderResultLines(text, { lineNumbers: true, highlight: false })
    // Width is 2 (for "12"), so line 1 is padded.
    expect(stripAnsi(r.lines[0])).toBe(" 1 │ L1")
    expect(stripAnsi(r.lines[11])).toBe("12 │ L12")
  })

  it("caps at maxLines and reports the hidden remainder", () => {
    const text = "a\nb\nc\nd\ne"
    const r = renderResultLines(text, { maxLines: 3, highlight: false })
    expect(r.lines).toEqual(["a", "b", "c"])
    expect(r.hiddenLines).toBe(2)
    expect(r.totalLines).toBe(5)
  })
})

describe("resultToText", () => {
  it("returns strings verbatim", () => {
    expect(resultToText("hi")).toBe("hi")
  })
  it("JSON-stringifies objects", () => {
    expect(resultToText({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
  it("returns empty for nullish", () => {
    expect(resultToText(null)).toBe("")
    expect(resultToText(undefined)).toBe("")
  })
})
