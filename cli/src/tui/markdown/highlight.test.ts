/**
 * @jest-environment node
 */
import { highlightCode, paletteCodeTheme, stripAnsi } from "./highlight"
import { getBuiltinTheme } from "../theme/builtins"

describe("highlightCode", () => {
  it("returns '' for empty code", () => {
    expect(highlightCode("")).toBe("")
  })

  it("preserves the code text after stripping color escapes", () => {
    const out = highlightCode("const x = 1", "js")
    expect(stripAnsi(out)).toBe("const x = 1")
  })

  it("falls back to plain text for an unsupported language", () => {
    const out = highlightCode("plain words", "not-a-real-lang")
    expect(stripAnsi(out)).toBe("plain words")
  })

  it("auto-detects when no language is given without throwing", () => {
    expect(() => highlightCode("def f(): pass")).not.toThrow()
  })
})

describe("highlightCode error fallback", () => {
  it("returns the original code when the highlighter throws", () => {
    jest.isolateModules(() => {
      jest.doMock("cli-highlight", () => ({
        supportsLanguage: () => true,
        highlight: () => {
          throw new Error("boom")
        },
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a sync re-require under the mock
      const { highlightCode: hc } = require("./highlight") as typeof import("./highlight")
      expect(hc("const x = 1", "js")).toBe("const x = 1")
    })
    jest.dontMock("cli-highlight")
  })
})

describe("paletteCodeTheme", () => {
  it("returns undefined for the classic (plain-ANSI) palette — keeps default output", () => {
    expect(paletteCodeTheme(getBuiltinTheme("classic"))).toBeUndefined()
  })

  it("builds a theme for a hex (truecolour) palette", () => {
    const theme = paletteCodeTheme(getBuiltinTheme("dark"))
    expect(theme).toBeDefined()
    expect(typeof theme!.keyword).toBe("function")
    // the chalk fn wraps text in ANSI escapes
    expect(stripAnsi(theme!.string!("x"))).toBe("x")
  })

  it("builds a theme when a code-highlight name is pinned even with ANSI tokens", () => {
    const base = getBuiltinTheme("classic")
    expect(paletteCodeTheme({ ...base, codeHighlight: "dracula" })).toBeDefined()
  })

  it("applies a themed palette without corrupting the code text", () => {
    const theme = paletteCodeTheme(getBuiltinTheme("dark"))
    expect(stripAnsi(highlightCode("const x = 1", "js", theme))).toBe("const x = 1")
  })
})

describe("stripAnsi", () => {
  it("removes color escape sequences", () => {
    expect(stripAnsi("[31mred[39m")).toBe("red")
  })
})
