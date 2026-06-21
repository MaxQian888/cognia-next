import { resolveTheme, THEME_CHOICES } from "./resolve"
import { getBuiltinTheme } from "./builtins"
import type { ResolvedConfig } from "../../config/schema"

function cfg(theme?: string): ResolvedConfig {
  return {
    provider: "anthropic",
    permissionMode: "default",
    builtinTools: {},
    providers: {},
    cwd: "/w",
    ...(theme ? { theme } : {}),
  } as ResolvedConfig
}

function reader(files: Record<string, string>) {
  return (p: string) => {
    const norm = p.replace(/\\/g, "/")
    for (const [k, v] of Object.entries(files)) if (norm.endsWith(k)) return v
    return null
  }
}

const deps = (files: Record<string, string> = {}) => ({
  osHome: "/home/u",
  cogniaHome: "/home/u/.cognia",
  read: reader(files),
})

describe("resolveTheme", () => {
  it("defaults to the cognia theme when no theme is set", () => {
    expect(resolveTheme(cfg(), deps())).toEqual(getBuiltinTheme("cognia"))
  })

  it("resolves a built-in theme by name", () => {
    expect(resolveTheme(cfg("dark"), deps())).toEqual(getBuiltinTheme("dark"))
  })

  it("resolves the legacy `classic` name to the raw-ANSI `ansi` palette", () => {
    expect(resolveTheme(cfg("classic"), deps())).toEqual(getBuiltinTheme("ansi"))
  })

  it("falls back to the default theme for an unknown theme name", () => {
    expect(resolveTheme(cfg("totally-made-up"), deps())).toEqual(getBuiltinTheme("cognia"))
  })

  it("reuses the Claude Code theme when theme = claude-code", () => {
    const p = resolveTheme(
      cfg("claude-code"),
      deps({ ".claude/settings.json": JSON.stringify({ theme: "dark" }) })
    )
    expect(p.accent.toLowerCase()).toBe("#d77757")
  })

  it("falls back to the default theme when claude-code is selected but Claude has no theme", () => {
    expect(resolveTheme(cfg("claude-code"), deps())).toEqual(getBuiltinTheme("cognia"))
  })

  it("reuses ONLY the code-block colours from Codex (UI stays raw-ANSI)", () => {
    const p = resolveTheme(cfg("codex"), deps({ ".codex/config.toml": '[tui]\ntheme = "dracula"' }))
    const ansi = getBuiltinTheme("ansi")
    // UI untouched (terminal-neutral ANSI chrome)
    expect(p.accent).toBe(ansi.accent)
    expect(p.border).toBe(ansi.border)
    expect(p.heading1).toBe(ansi.heading1)
    // code blocks recoloured + name recorded
    expect(p.codeKeyword.toLowerCase()).toBe("#ff79c6")
    expect(p.codeHighlight).toBe("dracula")
  })

  it("falls back to the default theme when codex is selected but Codex isn't configured", () => {
    expect(resolveTheme(cfg("codex"), deps())).toEqual(getBuiltinTheme("cognia"))
  })

  it("resolves our own custom theme from <cogniaHome>/themes/<slug>.json", () => {
    const p = resolveTheme(
      cfg("custom:neon"),
      deps({
        ".cognia/themes/neon.json": JSON.stringify({
          base: "dark",
          overrides: { accent: "#00ffcc", border: "ansi:cyanBright" },
        }),
      })
    )
    expect(p.accent.toLowerCase()).toBe("#00ffcc")
    expect(p.border).toBe("cyanBright")
    // untouched token keeps the base 'dark' value
    expect(p.success).toBe(getBuiltinTheme("dark").success)
  })

  it("falls back to the default theme when a custom theme file is missing", () => {
    expect(resolveTheme(cfg("custom:gone"), deps())).toEqual(getBuiltinTheme("cognia"))
  })

  it("expands a custom theme whose base is a BaseColors object (edits cascade)", () => {
    const p = resolveTheme(
      cfg("custom:mine"),
      deps({
        ".cognia/themes/mine.json": JSON.stringify({
          base: {
            accent: "#112233",
            secondary: "#222222",
            info: "#333333",
            success: "#444444",
            warning: "#555555",
            danger: "#666666",
            muted: "#777777",
            text: "#888888",
          },
        }),
      })
    )
    // The accent edit cascades to every accent-derived token via expandPalette.
    expect(p.accent.toLowerCase()).toBe("#112233")
    expect(p.border.toLowerCase()).toBe("#112233")
    expect(p.heading1.toLowerCase()).toBe("#112233")
    expect(p.selected.toLowerCase()).toBe("#112233")
    expect(p.text?.toLowerCase()).toBe("#888888")
  })

  it("normalizes base-object colours and falls back to classic for invalid roles", () => {
    const p = resolveTheme(
      cfg("custom:mixed"),
      deps({
        ".cognia/themes/mixed.json": JSON.stringify({
          base: { accent: "rgb(0,255,0)", muted: "not-a-color" },
          overrides: { heading2: "ansi:blueBright" },
        }),
      })
    )
    expect(p.accent.toLowerCase()).toBe("#00ff00")
    // invalid role → classic fallback
    expect(p.muted).toBe(getBuiltinTheme("classic").muted)
    // overrides still layer on top of the expanded base
    expect(p.heading2).toBe("blueBright")
  })

  it("exposes selectable theme choices including the reuse entries", () => {
    expect(THEME_CHOICES).toContain("cognia")
    expect(THEME_CHOICES).toContain("ansi")
    expect(THEME_CHOICES).toContain("dark")
    expect(THEME_CHOICES).toContain("claude-code")
    expect(THEME_CHOICES).toContain("codex")
    // legacy `classic` is a back-compat alias, not a picker choice
    expect(THEME_CHOICES).not.toContain("classic")
  })
})
