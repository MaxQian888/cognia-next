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
  it("defaults to classic when no theme is set", () => {
    expect(resolveTheme(cfg(), deps())).toEqual(getBuiltinTheme("classic"))
  })

  it("resolves a built-in theme by name", () => {
    expect(resolveTheme(cfg("dark"), deps())).toEqual(getBuiltinTheme("dark"))
  })

  it("falls back to classic for an unknown theme name", () => {
    expect(resolveTheme(cfg("totally-made-up"), deps())).toEqual(getBuiltinTheme("classic"))
  })

  it("reuses the Claude Code theme when theme = claude-code", () => {
    const p = resolveTheme(
      cfg("claude-code"),
      deps({ ".claude/settings.json": JSON.stringify({ theme: "dark" }) })
    )
    expect(p.accent.toLowerCase()).toBe("#d77757")
  })

  it("falls back to classic when claude-code is selected but Claude has no theme", () => {
    expect(resolveTheme(cfg("claude-code"), deps())).toEqual(getBuiltinTheme("classic"))
  })

  it("reuses ONLY the code-block colours from Codex (UI stays classic)", () => {
    const p = resolveTheme(cfg("codex"), deps({ ".codex/config.toml": '[tui]\ntheme = "dracula"' }))
    const classic = getBuiltinTheme("classic")
    // UI untouched
    expect(p.accent).toBe(classic.accent)
    expect(p.border).toBe(classic.border)
    expect(p.heading1).toBe(classic.heading1)
    // code blocks recoloured + name recorded
    expect(p.codeKeyword.toLowerCase()).toBe("#ff79c6")
    expect(p.codeHighlight).toBe("dracula")
  })

  it("falls back to classic when codex is selected but Codex isn't configured", () => {
    expect(resolveTheme(cfg("codex"), deps())).toEqual(getBuiltinTheme("classic"))
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

  it("falls back to classic when a custom theme file is missing", () => {
    expect(resolveTheme(cfg("custom:gone"), deps())).toEqual(getBuiltinTheme("classic"))
  })

  it("exposes selectable theme choices including the reuse entries", () => {
    expect(THEME_CHOICES).toContain("classic")
    expect(THEME_CHOICES).toContain("dark")
    expect(THEME_CHOICES).toContain("claude-code")
    expect(THEME_CHOICES).toContain("codex")
  })
})
