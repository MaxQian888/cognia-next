/**
 * @jest-environment jsdom
 */
import type { ThemeColors as AppearanceColors } from "@/types/plugin/plugin"
import {
  buildCogniaActiveEditorTheme,
  COGNIA_ACTIVE_THEME_ID,
  isWallpaperBehindEditors,
  readLiveSurfaceColors,
  resetCogniaActiveThemeSyncForTests,
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
    // The minimap canvas sits over the view lines — it must stay opaque or
    // long lines bleed through it.
    expect(theme.colors.minimap).toBe("#ffffff")
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

  it("turns the minimap 80% opaque only when a wallpaper paints behind editors", () => {
    const theme = buildCogniaActiveEditorTheme(makeAppearance(), "light", {
      wallpaperBehind: true,
    })
    expect(theme.colors.minimap).toBe("#ffffffcc")
  })

  it("emits empty tokenColors so toMonacoTheme inherits syntax highlighting from base", () => {
    const theme = buildCogniaActiveEditorTheme(makeAppearance(), "dark")
    expect(theme.tokenColors).toEqual([])
  })
})

function clearLiveDom() {
  for (const v of ["--background", "--foreground", "--muted-foreground", "--border", "--primary"]) {
    document.documentElement.style.removeProperty(v)
  }
  document.body.removeAttribute("data-bg-enabled")
  document.body.removeAttribute("data-bg-scope")
}

describe("readLiveSurfaceColors / isWallpaperBehindEditors", () => {
  afterEach(clearLiveDom)

  it("reads only the surface tokens the page is painted with", () => {
    document.documentElement.style.setProperty("--background", "oklch(0.145 0 0)")
    document.documentElement.style.setProperty("--border", "#222222")
    document.documentElement.style.setProperty("--primary", "#ffffff")
    // Accents stay the caller's: the default preset's `--primary` is a button
    // neutral that would wash out selections.
    expect(readLiveSurfaceColors()).toEqual({
      background: "oklch(0.145 0 0)",
      border: "#222222",
    })
  })

  it("is empty when the variables are unset", () => {
    expect(readLiveSurfaceColors()).toEqual({})
  })

  it("detects a wallpaper only for the scopes that clear Monaco's background", () => {
    expect(isWallpaperBehindEditors()).toBe(false)
    document.body.setAttribute("data-bg-enabled", "true")
    document.body.setAttribute("data-bg-scope", "chat")
    expect(isWallpaperBehindEditors()).toBe(false)
    for (const scope of ["canvas", "all", "global"]) {
      document.body.setAttribute("data-bg-scope", scope)
      expect(isWallpaperBehindEditors()).toBe(true)
    }
    document.body.setAttribute("data-bg-enabled", "false")
    expect(isWallpaperBehindEditors()).toBe(false)
  })
})

describe("syncCogniaActiveTheme", () => {
  afterEach(() => {
    resetCogniaActiveThemeSyncForTests()
    clearLiveDom()
    jest.useRealTimers()
  })

  it("paints the editor in the DOM's live background, not the resolved palette's", () => {
    // Default preset: the palette resolves navy, the DOM paints globals.css neutral.
    document.documentElement.style.setProperty("--background", "#0a0a0a")
    const defineTheme = jest.fn()
    syncCogniaActiveTheme(
      { editor: { defineTheme } },
      makeAppearance({ background: "#0b1220" }),
      "dark"
    )
    const [, data] = defineTheme.mock.calls[0]
    expect(data.colors["editor.background"]).toBe("#0a0a0a")
    expect(data.colors["minimap.background"]).toBe("#0a0a0a")
    // Accents still come from the resolved palette.
    expect(data.colors["editor.selectionBackground"]).toBe("#3b82f655")
  })

  it("re-syncs when the painted DOM changes after the caller ran, without looping", async () => {
    jest.useFakeTimers()
    const defineTheme = jest.fn()
    syncCogniaActiveTheme({ editor: { defineTheme } }, makeAppearance(), "dark")
    expect(defineTheme).toHaveBeenCalledTimes(1)

    // next-themes flips the class / variables after the editor's effect ran.
    document.documentElement.style.setProperty("--background", "#101010")
    await Promise.resolve() // deliver the MutationObserver record
    jest.runOnlyPendingTimers()
    expect(defineTheme).toHaveBeenCalledTimes(2)
    expect(defineTheme.mock.calls[1][1].colors["editor.background"]).toBe("#101010")

    // A mutation that changes nothing painted (Monaco rewriting its own
    // <style>) must not redefine.
    document.head.appendChild(document.createElement("style"))
    await Promise.resolve()
    jest.runOnlyPendingTimers()
    expect(defineTheme).toHaveBeenCalledTimes(2)
  })

  it("follows the wallpaper toggle on <body>", async () => {
    jest.useFakeTimers()
    const defineTheme = jest.fn()
    syncCogniaActiveTheme({ editor: { defineTheme } }, makeAppearance(), "light")
    document.body.setAttribute("data-bg-enabled", "true")
    document.body.setAttribute("data-bg-scope", "all")
    await Promise.resolve()
    jest.runOnlyPendingTimers()
    expect(defineTheme.mock.calls.at(-1)?.[1].colors["minimap.background"]).toBe("#ffffffcc")
  })

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
