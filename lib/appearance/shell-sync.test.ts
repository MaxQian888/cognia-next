/**
 * @jest-environment node
 */
import { DEFAULT_A11Y } from "@/types/appearance"
import type { CustomTheme } from "@/types/plugin/plugin"
import { HIGH_CONTRAST_DARK, HIGH_CONTRAST_LIGHT } from "./high-contrast-presets"
import { getShellColors } from "./shell-sync"

describe("getShellColors", () => {
  it("passes through hex values from the default preset on light theme", () => {
    const result = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: null,
        customThemes: [],
      },
      "light"
    )
    expect(result.backgroundHex.toLowerCase()).toBe("#ffffff")
    expect(result.foregroundHex.toLowerCase()).toBe("#0f172a")
    expect(result.isDark).toBe(false)
  })

  it("returns dark preset values when resolvedTheme is dark", () => {
    const result = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: null,
        customThemes: [],
      },
      "dark"
    )
    expect(result.backgroundHex.toLowerCase()).toBe("#0b1220")
    expect(result.foregroundHex.toLowerCase()).toBe("#f1f5f9")
    expect(result.isDark).toBe(true)
  })

  it("uses a custom theme's hex tokens when one is active", () => {
    const custom: CustomTheme = {
      id: "my-theme",
      name: "My Theme",
      isDark: true,
      colors: {
        primary: "#abcdef",
        secondary: "#222222",
        accent: "#333333",
        background: "#101010",
        foreground: "#eeeeee",
        muted: "#444444",
      },
    }
    const result = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: "my-theme",
        customThemes: [custom],
      },
      "dark"
    )
    expect(result.backgroundHex.toLowerCase()).toBe("#101010")
    expect(result.foregroundHex.toLowerCase()).toBe("#eeeeee")
    expect(result.isDark).toBe(true)
  })

  it("converts oklch custom-theme tokens to hex via culori", () => {
    const custom: CustomTheme = {
      id: "ok",
      name: "OK",
      isDark: false,
      colors: {
        primary: "oklch(0.7 0.2 30)",
        secondary: "oklch(0.5 0.1 200)",
        accent: "oklch(0.7 0.2 30)",
        background: "oklch(1 0 0)",
        foreground: "oklch(0 0 0)",
        muted: "oklch(0.95 0 0)",
      },
    }
    const result = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: "ok",
        customThemes: [custom],
      },
      "light"
    )
    expect(result.backgroundHex).toMatch(/^#[0-9a-f]{6}$/i)
    expect(result.foregroundHex).toMatch(/^#[0-9a-f]{6}$/i)
    // oklch(1 0 0) ≈ #ffffff; oklch(0 0 0) ≈ #000000
    expect(result.backgroundHex.toLowerCase()).toBe("#ffffff")
    expect(result.foregroundHex.toLowerCase()).toBe("#000000")
  })

  it("falls back to a safe default when a custom theme has unparseable colors", () => {
    const custom: CustomTheme = {
      id: "broken",
      name: "Broken",
      isDark: true,
      colors: {
        primary: "nope",
        secondary: "nope",
        accent: "nope",
        background: "not-a-color",
        foreground: "",
        muted: "nope",
      },
    }
    const result = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: "broken",
        customThemes: [custom],
      },
      "dark"
    )
    // `background` is a non-empty string that no parser can read, so nothing
    // upstream can rescue it and the shell's own fallback stands. `foreground`
    // is blank, which `normalizeThemeColors` reads as "unset" — so it now
    // resolves to the real dark default (`oklch(0.985 0 0)`) rather than
    // reaching the shell constant. That is the better answer: the window chrome
    // matches the page instead of a value only the shell knows about.
    expect(result.backgroundHex).toBe("#0b1220")
    expect(result.foregroundHex.toLowerCase()).toBe("#fafafa")
    expect(result.isDark).toBe(true)
  })

  it("still falls back to the shell constant when every token is unreadable", () => {
    const custom: CustomTheme = {
      id: "broken",
      name: "Broken",
      isDark: true,
      colors: { background: "not-a-color", foreground: "also-not-a-color" },
    }
    const result = getShellColors(
      { colorTheme: "default", activeCustomThemeId: "broken", customThemes: [custom] },
      "dark"
    )
    expect(result.backgroundHex).toBe("#0b1220")
    expect(result.foregroundHex).toBe("#f1f5f9")
  })

  it("derives isDark from resolvedTheme, not from the custom theme's isDark flag", () => {
    const custom: CustomTheme = {
      id: "light-theme",
      name: "Light Theme",
      isDark: false,
      colors: {
        primary: "#3b82f6",
        secondary: "#64748b",
        accent: "#3b82f6",
        background: "#ffffff",
        foreground: "#0f172a",
        muted: "#f1f5f9",
      },
    }
    // Even though the custom theme says light, we honour the resolvedTheme
    // argument so shell chrome stays in lockstep with next-themes.
    const result = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: "light-theme",
        customThemes: [custom],
      },
      "dark"
    )
    expect(result.isDark).toBe(true)
  })

  it("paints the shell from the high-contrast palette when a11y forces it", () => {
    // Regression: the native window / status bar used to stay on the normal
    // palette while the app repainted in high contrast.
    // The presets are authored in oklch; the shell paints hex, so assert the
    // converted values — that is what the window / status bar actually receives.
    const dark = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: null,
        customThemes: [],
        a11y: { ...DEFAULT_A11Y, highContrast: "dark" },
      },
      // Opposite variant on purpose: the a11y mode picks the palette.
      "light"
    )
    expect(HIGH_CONTRAST_DARK.background).toBe("oklch(0 0 0)")
    expect(dark.backgroundHex.toLowerCase()).toBe("#000000")
    expect(dark.foregroundHex.toLowerCase()).toBe("#ffffff")

    const light = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: null,
        customThemes: [],
        a11y: { ...DEFAULT_A11Y, highContrast: "light" },
      },
      "dark"
    )
    expect(HIGH_CONTRAST_LIGHT.background).toBe("oklch(1 0 0)")
    expect(light.backgroundHex.toLowerCase()).toBe("#ffffff")
    expect(light.foregroundHex.toLowerCase()).not.toBe("#ffffff")
  })

  it("paints the shell from an active plugin theme's declared tokens", () => {
    const result = getShellColors(
      {
        colorTheme: "default",
        activeCustomThemeId: null,
        customThemes: [],
        pluginTheme: { variables: { "--background": "#123456" } },
      },
      "dark"
    )
    expect(result.backgroundHex.toLowerCase()).toBe("#123456")
  })
})
