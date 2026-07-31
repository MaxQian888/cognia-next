import {
  parseCodexThemeName,
  readCodexHighlightTheme,
  codexCodeOverrides,
  CODEX_DEFAULT_HIGHLIGHT_THEME,
} from "./codex"

describe("parseCodexThemeName", () => {
  it("reads a dotted tui.theme assignment", () => {
    expect(parseCodexThemeName('tui.theme = "dracula"')).toBe("dracula")
  })

  it("reads theme under a [tui] section", () => {
    const toml = ["[general]", 'foo = "bar"', "", "[tui]", 'theme = "gruvbox-dark"', "x = 1"].join(
      "\n"
    )
    expect(parseCodexThemeName(toml)).toBe("gruvbox-dark")
  })

  it("ignores a theme key in a different section", () => {
    const toml = ["[other]", 'theme = "nope"', "", "[tui]", 'foo = "bar"'].join("\n")
    expect(parseCodexThemeName(toml)).toBeNull()
  })

  it("tolerates single quotes and extra whitespace", () => {
    expect(parseCodexThemeName("[tui]\n   theme   =   'catppuccin-mocha'  ")).toBe(
      "catppuccin-mocha"
    )
  })

  it("returns null when there is no theme", () => {
    expect(parseCodexThemeName('[tui]\nfoo = "bar"')).toBeNull()
    expect(parseCodexThemeName("")).toBeNull()
  })
})

describe("readCodexHighlightTheme", () => {
  const read = (content: string | null) => () => content
  it("returns the theme name from ~/.codex/config.toml", () => {
    expect(readCodexHighlightTheme({ osHome: "/h", read: read('[tui]\ntheme = "dracula"') })).toBe(
      "dracula"
    )
  })
  it("returns null when there is no codex config", () => {
    expect(readCodexHighlightTheme({ osHome: "/h", read: read(null) })).toBeNull()
  })
})

describe("codexCodeOverrides", () => {
  it("maps a known theme to hex code-block tokens (and records the name)", () => {
    const o = codexCodeOverrides("dracula")
    expect(o.codeKeyword).toMatch(/^#[0-9a-f]{6}$/i)
    expect(o.codeString).toMatch(/^#[0-9a-f]{6}$/i)
    expect(o.codeHighlight).toBe("dracula")
  })

  it("falls back to a generic palette for an unknown theme but keeps the name", () => {
    const o = codexCodeOverrides("some-unknown-theme")
    expect(o.codeKeyword).toMatch(/^#[0-9a-f]{6}$/i)
    expect(o.codeHighlight).toBe("some-unknown-theme")
  })

  it("only sets code-block tokens (never UI tokens like accent/border)", () => {
    const o = codexCodeOverrides("dracula") as Record<string, unknown>
    expect(o.accent).toBeUndefined()
    expect(o.border).toBeUndefined()
    expect(o.heading1).toBeUndefined()
  })

  it("maps Codex's own default (catppuccin-mocha) rather than the generic fallback", () => {
    const mocha = codexCodeOverrides("catppuccin-mocha")
    const fallback = codexCodeOverrides("some-unknown-theme")
    expect(mocha.codeHighlight).toBe("catppuccin-mocha")
    // A recognised base ⇒ different tokens from the neutral fallback.
    expect(mocha.codeKeyword).not.toBe(fallback.codeKeyword)
  })

  it("maps the catppuccin-latte light default to its own (distinct) palette", () => {
    const latte = codexCodeOverrides("catppuccin-latte")
    const mocha = codexCodeOverrides("catppuccin-mocha")
    expect(latte.codeHighlight).toBe("catppuccin-latte")
    expect(latte.codeKeyword).toMatch(/^#[0-9a-f]{6}$/i)
    // Light vs dark variant must not collapse to the same tokens.
    expect(latte.codeKeyword).not.toBe(mocha.codeKeyword)
  })

  it("exposes catppuccin-mocha as Codex's default highlight theme", () => {
    expect(CODEX_DEFAULT_HIGHLIGHT_THEME).toBe("catppuccin-mocha")
  })
})
