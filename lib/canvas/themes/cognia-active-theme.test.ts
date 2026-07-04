/**
 * @jest-environment node
 */
import type { ThemeColors as AppearanceColors } from "@/types/plugin/plugin-extended"
import {
  buildCogniaActiveEditorTheme,
  COGNIA_ACTIVE_THEME_ID,
  syncCogniaActiveTheme,
} from "./cognia-active-theme"
import { themeRegistry } from "./theme-registry"

function makeAppearance(overrides: Partial<AppearanceColors> = {}): AppearanceColors {
  return {
    primary: "#3b82f6",
    primaryForeground: "#ffffff",
    secondary: "#64748b",
    secondaryForeground: "#ffffff",
    accent: "#3b82f6",
    accentForeground: "#ffffff",
    background: "#ffffff",
    foreground: "#0f172a",
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
    sidebarBorder: "#e2e8f0",
    sidebarPrimaryForeground: "#ffffff",
    sidebarAccent: "#f1f5f9",
    sidebarAccentForeground: "#0f172a",
    sidebarRing: "#3b82f6",
    ...overrides,
  }
}

describe("buildCogniaActiveEditorTheme", () => {
  it("passes through hex appearance values into Monaco editor surfaces", () => {
    const theme = buildCogniaActiveEditorTheme(makeAppearance(), "light")
    expect(theme.id).toBe(COGNIA_ACTIVE_THEME_ID)
    expect(theme.dark).toBe(false)
    expect(theme.base).toBe("vs")
    expect(theme.colors.background).toBe("#ffffff")
    expect(theme.colors.foreground).toBe("#0f172a")
    expect(theme.colors.cursor).toBe("#0f172a")
    // Minimap clears fully transparent so a wallpaper shows through the canvas.
    expect(theme.colors.minimap).toBe("#ffffff00")
    expect(theme.colors.gutterBackground).toBe("#ffffff")
  })

  it("selects vs-dark base and dark-mode fallbacks when variant is dark", () => {
    const theme = buildCogniaActiveEditorTheme(makeAppearance({ background: "#0b1220" }), "dark")
    expect(theme.dark).toBe(true)
    expect(theme.base).toBe("vs-dark")
    expect(theme.colors.background).toBe("#0b1220")
  })

  it("appends Monaco alpha suffixes to selection / scrollbar tokens", () => {
    const theme = buildCogniaActiveEditorTheme(makeAppearance(), "light")
    // selection: primary + "55"
    expect(theme.colors.selection).toBe("#3b82f655")
    // selectionHighlight: primary + "26"
    expect(theme.colors.selectionHighlight).toBe("#3b82f626")
    expect(theme.colors.scrollbarSlider).toMatch(/^#[0-9a-f]{6}55$/i)
    expect(theme.colors.scrollbarSliderHover).toMatch(/^#[0-9a-f]{6}99$/i)
    expect(theme.colors.matchingBracket).toMatch(/^#[0-9a-f]{6}33$/i)
  })

  it("converts oklch appearance values to hex via culori", () => {
    const theme = buildCogniaActiveEditorTheme(
      makeAppearance({ background: "oklch(1 0 0)", foreground: "oklch(0 0 0)" }),
      "light"
    )
    expect(theme.colors.background).toMatch(/^#[0-9a-f]{6}$/i)
    expect(theme.colors.foreground).toMatch(/^#[0-9a-f]{6}$/i)
    // oklch(1 0 0) ≈ #ffffff; oklch(0 0 0) ≈ #000000
    expect(theme.colors.background.toLowerCase()).toBe("#ffffff")
    expect(theme.colors.foreground.toLowerCase()).toBe("#000000")
  })

  it("falls back to safe defaults when appearance values are unparseable", () => {
    const theme = buildCogniaActiveEditorTheme(
      makeAppearance({ background: "not-a-color", foreground: "" }),
      "dark"
    )
    // Dark fallbacks
    expect(theme.colors.background).toBe("#0b1220")
    expect(theme.colors.foreground).toBe("#f1f5f9")
  })

  it("derives lineHighlight by lightening the background in dark mode", () => {
    const theme = buildCogniaActiveEditorTheme(makeAppearance({ background: "#000000" }), "dark")
    // lighten("#000000", 0.06) → mix toward white at 6% → non-pure-black
    expect(theme.colors.lineHighlight).not.toBe("#000000")
    expect(theme.colors.lineHighlight).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it("emits empty tokenColors so toMonacoTheme inherits syntax highlighting from base", () => {
    const theme = buildCogniaActiveEditorTheme(makeAppearance(), "dark")
    expect(theme.tokenColors).toEqual([])
  })
})

describe("syncCogniaActiveTheme", () => {
  it("registers the theme on themeRegistry and calls monaco.editor.defineTheme", () => {
    const defineTheme = jest.fn()
    const monaco = { editor: { defineTheme } }

    syncCogniaActiveTheme(monaco, makeAppearance(), "light")

    expect(themeRegistry.getTheme(COGNIA_ACTIVE_THEME_ID)).toBeDefined()
    expect(defineTheme).toHaveBeenCalledTimes(1)
    const [name, data] = defineTheme.mock.calls[0]
    expect(name).toBe(COGNIA_ACTIVE_THEME_ID)
    expect(data.base).toBe("vs")
    expect(data.inherit).toBe(true)
    expect(data.colors["editor.background"]).toBe("#ffffff")
  })

  it("is idempotent — repeated calls overwrite in place without throwing", () => {
    const defineTheme = jest.fn()
    const monaco = { editor: { defineTheme } }

    syncCogniaActiveTheme(monaco, makeAppearance({ background: "#fafafa" }), "light")
    syncCogniaActiveTheme(monaco, makeAppearance({ background: "#111111" }), "dark")

    expect(defineTheme).toHaveBeenCalledTimes(2)
    const latest = themeRegistry.getTheme(COGNIA_ACTIVE_THEME_ID)
    expect(latest?.dark).toBe(true)
    expect(latest?.colors.background).toBe("#111111")
  })
})
