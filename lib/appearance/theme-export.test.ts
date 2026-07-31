import { exportThemeToJson, importThemeFromJson } from "./theme-export"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin"

function buildTokens(overrides: Partial<ThemeColors> = {}): ThemeColors {
  return {
    background: "#ffffff",
    foreground: "#0f172a",
    primary: "#3b82f6",
    primaryForeground: "#ffffff",
    secondary: "#64748b",
    secondaryForeground: "#ffffff",
    accent: "#3b82f6",
    accentForeground: "#ffffff",
    muted: "#f1f5f9",
    mutedForeground: "#64748b",
    card: "#ffffff",
    cardForeground: "#0f172a",
    popover: "#ffffff",
    popoverForeground: "#0f172a",
    input: "#e2e8f0",
    border: "#e2e8f0",
    ring: "#3b82f6",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    sidebar: "#f8fafc",
    sidebarForeground: "#0f172a",
    sidebarPrimary: "#3b82f6",
    sidebarPrimaryForeground: "#ffffff",
    sidebarAccent: "#f1f5f9",
    sidebarAccentForeground: "#0f172a",
    sidebarBorder: "#e2e8f0",
    sidebarRing: "#3b82f6",
    ...overrides,
  } as ThemeColors
}

describe("exportThemeToJson", () => {
  it("produces a JSON document with $schema, formatVersion, and pretty-printed tokens", () => {
    const theme: CustomTheme = {
      id: "x",
      name: "Demo",
      baseVariant: "dark",
      derivedVariant: "light",
      tokens: { light: buildTokens(), dark: buildTokens({ background: "#0b0b0b" }) },
    }
    const json = exportThemeToJson(theme)
    const parsed = JSON.parse(json)
    expect(parsed.$schema).toBe("https://cognia.dev/schemas/custom-theme/v1.json")
    expect(parsed.formatVersion).toBe("v1")
    expect(parsed.name).toBe("Demo")
    expect(parsed.baseVariant).toBe("dark")
    expect(parsed.derivedVariant).toBe("light")
    expect(parsed.tokens.dark.background).toBe("#0b0b0b")
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Pretty-printed: contains newlines + 2-space indent.
    expect(json).toContain("\n  ")
  })

  it("infers baseVariant from legacy isDark when missing", () => {
    const theme: CustomTheme = {
      id: "x",
      name: "Legacy",
      isDark: true,
      tokens: { light: buildTokens(), dark: buildTokens() },
    }
    const json = exportThemeToJson(theme)
    expect(JSON.parse(json).baseVariant).toBe("dark")
  })

  it("throws when tokens are missing", () => {
    const theme: CustomTheme = {
      id: "x",
      name: "Bad",
      isDark: true,
      colors: buildTokens(),
    }
    expect(() => exportThemeToJson(theme)).toThrow(/no dual-variant tokens/i)
  })

  it("omits derivedVariant when not set", () => {
    const theme: CustomTheme = {
      id: "x",
      name: "Demo",
      baseVariant: "dark",
      tokens: { light: buildTokens(), dark: buildTokens() },
    }
    const parsed = JSON.parse(exportThemeToJson(theme))
    expect("derivedVariant" in parsed).toBe(false)
  })
})

describe("importThemeFromJson", () => {
  it("round-trips a theme exported by exportThemeToJson", () => {
    const original: CustomTheme = {
      id: "x",
      name: "Round Trip",
      baseVariant: "dark",
      derivedVariant: "light",
      tokens: { light: buildTokens({ primary: "#aaa" }), dark: buildTokens({ primary: "#bbb" }) },
    }
    const json = exportThemeToJson(original)
    const restored = importThemeFromJson(json)
    expect(restored.name).toBe("Round Trip")
    expect(restored.baseVariant).toBe("dark")
    expect(restored.derivedVariant).toBe("light")
    expect(restored.tokens?.light.primary).toBe("#aaa")
    expect(restored.tokens?.dark.primary).toBe("#bbb")
    expect("id" in restored).toBe(false)
  })

  it("rejects non-JSON input", () => {
    expect(() => importThemeFromJson("not json")).toThrow(/invalid/i)
  })

  it("rejects non-object roots", () => {
    expect(() => importThemeFromJson("123")).toThrow(/object/i)
  })

  it("rejects missing tokens", () => {
    const json = JSON.stringify({
      $schema: "x",
      formatVersion: "v1",
      name: "Bad",
      baseVariant: "dark",
    })
    expect(() => importThemeFromJson(json)).toThrow(/tokens/i)
  })

  it("rejects missing tokens.dark", () => {
    const json = JSON.stringify({
      $schema: "x",
      formatVersion: "v1",
      name: "Bad",
      baseVariant: "dark",
      tokens: { light: buildTokens() },
    })
    expect(() => importThemeFromJson(json)).toThrow(/tokens\.light or tokens\.dark/i)
  })

  it("rejects invalid baseVariant", () => {
    const json = JSON.stringify({
      $schema: "x",
      formatVersion: "v1",
      name: "Bad",
      tokens: { light: buildTokens(), dark: buildTokens() },
    })
    expect(() => importThemeFromJson(json)).toThrow(/baseVariant/i)
  })

  it("defaults name to 'Imported Theme' when missing", () => {
    const json = JSON.stringify({
      $schema: "x",
      formatVersion: "v1",
      baseVariant: "dark",
      tokens: { light: buildTokens(), dark: buildTokens() },
    })
    const restored = importThemeFromJson(json)
    expect(restored.name).toBe("Imported Theme")
  })
})
