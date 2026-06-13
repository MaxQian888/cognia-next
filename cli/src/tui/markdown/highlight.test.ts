/**
 * @jest-environment node
 */
import {
  highlightCode,
  highlightLine,
  langFromPath,
  paletteCodeTheme,
  stripAnsi,
  tintAnsi,
} from "./highlight"
import { getBuiltinTheme } from "../theme/builtins"

const ESC = String.fromCharCode(27)
const RESET = `${ESC}[39m`

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

describe("highlightLine", () => {
  it("returns the original (falsy) input unchanged", () => {
    expect(highlightLine("")).toBe("")
  })

  it("preserves text and strips any trailing newline", () => {
    const out = highlightLine("const x = 1", "typescript")
    expect(stripAnsi(out)).toBe("const x = 1")
    expect(out.endsWith("\n")).toBe(false)
  })
})

describe("langFromPath", () => {
  it("maps known extensions case-insensitively", () => {
    expect(langFromPath("/a/b.ts")).toBe("typescript")
    expect(langFromPath("/a/b.RS")).toBe("rust")
    expect(langFromPath("C:\\a\\b.py")).toBe("python")
  })

  it("returns undefined for unknown extensions and dotfiles/extensionless names", () => {
    expect(langFromPath("/a/b.unknownext")).toBeUndefined()
    expect(langFromPath("/a/LICENSE")).toBeUndefined()
    expect(langFromPath("/a/.bashrc")).toBeUndefined()
  })
})

describe("tintAnsi", () => {
  it("opens with a named ANSI foreground and closes with a reset", () => {
    const out = tintAnsi("hi", "green")
    expect(out).toBe(`${ESC}[32mhi${RESET}`)
  })

  it("emits a truecolour foreground for a hex value", () => {
    const out = tintAnsi("hi", "#ff8800")
    expect(out).toBe(`${ESC}[38;2;255;136;0mhi${RESET}`)
  })

  it("re-asserts the outer colour after each inner default-fg reset (role wins)", () => {
    // highlighted `const` (blue) then plain text — the plain part must regain green.
    const highlighted = `${ESC}[34mconst${RESET} x`
    const out = tintAnsi(highlighted, "green")
    expect(out).toBe(`${ESC}[32m${ESC}[34mconst${RESET}${ESC}[32m x${RESET}`)
    // the inner keyword colour survives …
    expect(out).toContain(`${ESC}[34m`)
    // … and the role colour brackets it.
    expect(out.startsWith(`${ESC}[32m`)).toBe(true)
  })

  it("leaves text untouched for an unknown colour value", () => {
    expect(tintAnsi("hi", "not-a-colour")).toBe("hi")
    expect(tintAnsi("hi", "#xyzxyz")).toBe("hi")
  })
})

describe("stripAnsi", () => {
  it("removes color escape sequences", () => {
    expect(stripAnsi("[31mred[39m")).toBe("red")
  })
})
