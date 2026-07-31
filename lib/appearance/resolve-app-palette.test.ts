import { colorblindThemeOverrides } from "@/lib/appearance/colorblind-palettes"
import { HIGH_CONTRAST_DARK, HIGH_CONTRAST_LIGHT } from "@/lib/appearance/high-contrast-presets"
import { pluginThemeColors, resolveAppPalette } from "@/lib/appearance/resolve-app-palette"
import { DEFAULT_A11Y } from "@/types/appearance"
import type { CustomTheme } from "@/types/plugin/plugin"

const base = {
  colorTheme: "default" as const,
  activeCustomThemeId: null,
  customThemes: [] as CustomTheme[],
}

describe("resolveAppPalette", () => {
  it("reads any non-light resolved theme as dark, including undefined", () => {
    expect(resolveAppPalette({ ...base, resolvedTheme: "light" }).variant).toBe("light")
    expect(resolveAppPalette({ ...base, resolvedTheme: "dark" }).variant).toBe("dark")
    // next-themes can still be hydrating, and "system" is never resolved output —
    // both must land somewhere deterministic rather than throwing.
    expect(resolveAppPalette({ ...base, resolvedTheme: undefined }).variant).toBe("dark")
    expect(resolveAppPalette({ ...base, resolvedTheme: "system" }).variant).toBe("dark")
  })

  it("applies the standalone accent override to primary / accent / ring", () => {
    // The regression this module exists for: `use-code-server-theme-sync` never
    // passed `accentColor`, so the embedded editor ignored it.
    const accent = "#ff0088"
    const resolved = resolveAppPalette({ ...base, resolvedTheme: "dark", accentColor: accent })
    expect(resolved.colors.primary).toBe(accent)
    expect(resolved.colors.accent).toBe(accent)
    expect(resolved.colors.ring).toBe(accent)
    expect(resolved.source).toBe("preset")
  })

  it("treats a blank accent as no override", () => {
    const withBlank = resolveAppPalette({ ...base, resolvedTheme: "dark", accentColor: "" })
    const without = resolveAppPalette({ ...base, resolvedTheme: "dark" })
    expect(withBlank.colors).toEqual(without.colors)
  })

  it("lets high contrast replace the whole palette and reports it", () => {
    for (const [mode, preset] of [
      ["dark", HIGH_CONTRAST_DARK],
      ["light", HIGH_CONTRAST_LIGHT],
    ] as const) {
      const resolved = resolveAppPalette({
        ...base,
        resolvedTheme: mode === "dark" ? "light" : "dark", // the mode wins over the variant
        a11y: { ...DEFAULT_A11Y, highContrast: mode },
      })
      expect(resolved.highContrast).toBe(true)
      expect(resolved.source).toBe("high-contrast")
      expect(resolved.colors.background).toBe(preset.background)
      expect(resolved.colors.foreground).toBe(preset.foreground)
    }
  })

  it("high contrast outranks a custom theme and an accent override", () => {
    const custom: CustomTheme = {
      id: "c1",
      name: "Mine",
      baseVariant: "dark",
      tokens: { dark: { background: "#123456" }, light: {} },
    } as unknown as CustomTheme
    const resolved = resolveAppPalette({
      colorTheme: "default",
      resolvedTheme: "dark",
      activeCustomThemeId: "c1",
      customThemes: [custom],
      accentColor: "#ff0088",
      a11y: { ...DEFAULT_A11Y, highContrast: "dark" },
    })
    expect(resolved.colors.background).toBe(HIGH_CONTRAST_DARK.background)
    expect(resolved.colors.primary).not.toBe("#ff0088")
  })

  it("layers colorblind overrides on top of whichever base won", () => {
    const overrides = colorblindThemeOverrides("deuter")
    // Guard the fixture: if the palette stops overriding theme tokens this test
    // would silently assert nothing.
    expect(Object.keys(overrides).length).toBeGreaterThan(0)

    const preset = resolveAppPalette({
      ...base,
      resolvedTheme: "dark",
      a11y: { ...DEFAULT_A11Y, colorblindMode: "deuter" },
    })
    const hc = resolveAppPalette({
      ...base,
      resolvedTheme: "dark",
      a11y: { ...DEFAULT_A11Y, highContrast: "dark", colorblindMode: "deuter" },
    })
    for (const [key, value] of Object.entries(overrides)) {
      expect(preset.colors[key as keyof typeof preset.colors]).toBe(value)
      expect(hc.colors[key as keyof typeof hc.colors]).toBe(value)
    }
    expect(preset.colorblind).toBe("deuter")
  })

  it("defaults both a11y axes to off when the slice is absent", () => {
    const resolved = resolveAppPalette({ ...base, resolvedTheme: "dark" })
    expect(resolved.highContrast).toBe(false)
    expect(resolved.colorblind).toBe("off")
  })

  it("lets a plugin theme override the resolved base, keeping undeclared tokens", () => {
    const resolved = resolveAppPalette({
      ...base,
      resolvedTheme: "dark",
      pluginTheme: { colors: { background: "#010203" } as never },
    })
    expect(resolved.source).toBe("plugin")
    expect(resolved.colors.background).toBe("#010203")
    // Not declared by the plugin theme — must still resolve to the baseline.
    expect(resolved.colors.foreground).toBeTruthy()
  })

  it("ignores a plugin theme under high contrast", () => {
    const resolved = resolveAppPalette({
      ...base,
      resolvedTheme: "dark",
      pluginTheme: { colors: { background: "#010203" } as never },
      a11y: { ...DEFAULT_A11Y, highContrast: "dark" },
    })
    expect(resolved.source).toBe("high-contrast")
    expect(resolved.colors.background).toBe(HIGH_CONTRAST_DARK.background)
  })

  it("hardens a foreground that clashes with its surface", () => {
    // Black-on-black is the pathological case the DOM applier guards against;
    // non-DOM consumers have no stylesheet to fall back to, so it must be fixed
    // here rather than deferred.
    const custom: CustomTheme = {
      id: "clash",
      name: "Clash",
      baseVariant: "dark",
      tokens: { dark: { background: "#000000", foreground: "#050505" }, light: {} },
    } as unknown as CustomTheme
    const resolved = resolveAppPalette({
      colorTheme: "default",
      resolvedTheme: "dark",
      activeCustomThemeId: "clash",
      customThemes: [custom],
    })
    expect(resolved.colors.foreground).not.toBe("#050505")
  })
})

describe("pluginThemeColors", () => {
  it("prefers a structured palette when the theme declares one", () => {
    const colors = { background: "#111111" } as never
    expect(pluginThemeColors({ colors, variables: { "--background": "#222222" } })).toBe(colors)
  })

  it("inverts the CSS-variable map for cssVariables themes", () => {
    const read = pluginThemeColors({
      variables: {
        "--background": "#0a0a0a",
        "--sidebar-primary-foreground": "oklch(0.9 0 0)",
        // Not a ThemeColors token — must not leak into the palette.
        "--chart-1": "#ff0000",
      },
    })
    expect(read.background).toBe("#0a0a0a")
    expect(read.sidebarPrimaryForeground).toBe("oklch(0.9 0 0)")
    expect(Object.keys(read)).toHaveLength(2)
  })

  it("lets cssVars win over variables and drops blank declarations", () => {
    const read = pluginThemeColors({
      variables: { "--background": "#000000", "--foreground": "   " },
      cssVars: { "--background": "#ffffff" },
    })
    expect(read.background).toBe("#ffffff")
    expect(read.foreground).toBeUndefined()
  })

  it("returns an empty palette for a theme with neither shape", () => {
    expect(pluginThemeColors({})).toEqual({})
  })
})
