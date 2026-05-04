// Unit tests for `resolveActiveThemeColors`. Covers the Phase-2 dual-variant
// `tokens.{light, dark}` shape AND the legacy single-`colors` fallback that
// stays alive until the Task 8 Dexie v16 migration runs.

import { resolveActiveThemeColors } from "./index"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin-extended"

// 27-key fixture builder, mirroring `lib/appearance/derive-variant.test.ts`.
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

describe("resolveActiveThemeColors — preset path", () => {
  it("returns the preset's light palette when no custom theme is active", () => {
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "light",
      activeCustomThemeId: null,
      customThemes: [],
    })
    expect(result.themeSource).toBe("preset")
    expect(result.colors.background).toBe("#ffffff")
  })

  it("returns the preset's dark palette when resolvedTheme=dark", () => {
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "dark",
      activeCustomThemeId: null,
      customThemes: [],
    })
    expect(result.themeSource).toBe("preset")
    expect(result.colors.background).toBe("#0b1220")
  })

  it("falls through to the default preset for an unknown colorTheme", () => {
    const result = resolveActiveThemeColors({
      // Force-cast: simulating a stale persisted value the runtime
      // doesn't recognise. The function should still resolve.
      colorTheme: "unknown" as never,
      resolvedTheme: "light",
      activeCustomThemeId: null,
      customThemes: [],
    })
    expect(result.themeSource).toBe("preset")
    expect(result.colors.background).toBe("#ffffff")
  })

  it("falls through to preset when activeCustomThemeId points to a missing row", () => {
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "light",
      activeCustomThemeId: "ghost",
      customThemes: [],
    })
    expect(result.themeSource).toBe("preset")
    expect(result.colors.background).toBe("#ffffff")
  })
})

describe("resolveActiveThemeColors — dual-variant tokens (Phase 2 shape)", () => {
  it("reads tokens.dark when resolvedTheme=dark and dual-shape present", () => {
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "dark",
      activeCustomThemeId: "t1",
      customThemes: [
        {
          id: "t1",
          name: "X",
          baseVariant: "dark",
          tokens: {
            light: buildTokens({ primary: "#aaaaaa" }),
            dark: buildTokens({ primary: "#ff00ff" }),
          },
        } as CustomTheme,
      ],
    })
    expect(result.themeSource).toBe("custom")
    expect(result.colors.primary).toBe("#ff00ff")
  })

  it("reads tokens.light when resolvedTheme=light and dual-shape present", () => {
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "light",
      activeCustomThemeId: "t1",
      customThemes: [
        {
          id: "t1",
          name: "X",
          baseVariant: "dark",
          tokens: {
            light: buildTokens({ primary: "#aaaaaa" }),
            dark: buildTokens({ primary: "#ff00ff" }),
          },
        } as CustomTheme,
      ],
    })
    expect(result.themeSource).toBe("custom")
    expect(result.colors.primary).toBe("#aaaaaa")
  })

  it("baseVariant=light makes the light preset the baseline for unspecified keys", () => {
    // tokens.dark only overrides `primary`; everything else should come
    // from the preset's light palette (because baseVariant === "light").
    const partial = { primary: "#abcdef" } as ThemeColors
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "dark",
      activeCustomThemeId: "t1",
      customThemes: [
        {
          id: "t1",
          name: "X",
          baseVariant: "light",
          tokens: { light: partial, dark: partial },
        } as CustomTheme,
      ],
    })
    expect(result.colors.primary).toBe("#abcdef")
    // Background not overridden by `partial` → comes from light preset.
    expect(result.colors.background).toBe("#ffffff")
  })
})

describe("resolveActiveThemeColors — legacy fallback (pre-migration rows)", () => {
  it("falls back to legacy colors when tokens missing", () => {
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "dark",
      activeCustomThemeId: "t1",
      customThemes: [
        {
          id: "t1",
          name: "X",
          isDark: true,
          colors: buildTokens({ primary: "#abcdef" }),
        } as CustomTheme,
      ],
    })
    expect(result.themeSource).toBe("custom")
    expect(result.colors.primary).toBe("#abcdef")
  })

  it("legacy row with isDark mismatch falls through to preset (no overrides)", () => {
    // row.isDark === true but resolvedTheme === "light" → custom.colors is ignored.
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "light",
      activeCustomThemeId: "t1",
      customThemes: [
        {
          id: "t1",
          name: "X",
          isDark: true,
          colors: buildTokens({ primary: "#abcdef" }),
        } as CustomTheme,
      ],
    })
    // The custom theme is still considered "custom" (the row exists),
    // but its colors aren't applied because the variant mismatched.
    expect(result.themeSource).toBe("custom")
    // Should NOT be the legacy override.
    expect(result.colors.primary).not.toBe("#abcdef")
    // Baseline: variantHint is "dark" (from isDark=true), so the dark
    // preset is the baseline even though resolvedTheme is light.
    expect(result.colors.background).toBe("#0b1220")
  })

  it("legacy row with no isDark uses the resolvedTheme baseline", () => {
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "light",
      activeCustomThemeId: "t1",
      customThemes: [
        {
          id: "t1",
          name: "X",
          colors: { primary: "#abcdef" },
        } as CustomTheme,
      ],
    })
    expect(result.themeSource).toBe("custom")
    // Without isDark, the resolvedTheme drives the baseline AND the
    // mismatch-check (isDark === undefined) means custom.colors is
    // dropped — so we get a pure preset light palette with no overrides.
    expect(result.colors.primary).not.toBe("#abcdef")
    expect(result.colors.background).toBe("#ffffff")
  })

  it("dual-variant tokens win over legacy colors when both are present", () => {
    const result = resolveActiveThemeColors({
      colorTheme: "default",
      resolvedTheme: "dark",
      activeCustomThemeId: "t1",
      customThemes: [
        {
          id: "t1",
          name: "X",
          baseVariant: "dark",
          tokens: {
            light: buildTokens({ primary: "#aaaaaa" }),
            dark: buildTokens({ primary: "#ff00ff" }),
          },
          // Legacy fields still present; should be ignored.
          isDark: true,
          colors: buildTokens({ primary: "#deadbe" }),
        } as CustomTheme,
      ],
    })
    expect(result.colors.primary).toBe("#ff00ff")
  })
})
