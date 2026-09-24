import { resolveActiveThemeColors } from "@/lib/themes"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin"

import {
  customThemeBaseVariant,
  customThemeVariantIn,
  pluginThemeVariantIn,
  resolveActiveThemeSummary,
  themeModeFromResolved,
  type ThemeMode,
} from "./active-theme-variant"

const DARK_BG = "#101010"
const LIGHT_BG = "#fafafa"
const palette = (background: string) => ({ background }) as unknown as ThemeColors

const dualDerived: CustomTheme = {
  id: "dracula",
  name: "Dracula",
  baseVariant: "dark",
  derivedVariant: "light",
  tokens: { dark: palette(DARK_BG), light: palette(LIGHT_BG) },
  isDark: true,
  colors: palette(DARK_BG),
  sourceBuiltinName: "Dracula",
}

const dualAuthored: CustomTheme = {
  id: "hand",
  name: "Hand-made",
  baseVariant: "light",
  tokens: { dark: palette(DARK_BG), light: palette(LIGHT_BG) },
}

const legacyDark: CustomTheme = {
  id: "legacy",
  name: "Legacy dark",
  isDark: true,
  colors: palette(DARK_BG),
}

const legacyNoVariant: CustomTheme = {
  id: "unknown",
  name: "No variant",
  colors: palette(DARK_BG),
}

// What `ctx.theme.registerCustomTheme` stores when a plugin sends only `colors`.
const pluginRegisteredSingle: CustomTheme = {
  id: "plugin-single",
  name: "Plugin single",
  baseVariant: "dark",
  isDark: true,
  colors: palette(DARK_BG),
  ownerPluginId: "some.plugin",
}

describe("themeModeFromResolved", () => {
  it("mirrors the applier: light is light, anything else is dark, nothing is unknown", () => {
    expect(themeModeFromResolved("light")).toBe("light")
    expect(themeModeFromResolved("dark")).toBe("dark")
    expect(themeModeFromResolved("system")).toBe("dark")
    expect(themeModeFromResolved(undefined)).toBeNull()
    expect(themeModeFromResolved("")).toBeNull()
  })
})

describe("customThemeVariantIn", () => {
  it("a built-in preset clone paints its own palette in its mode and a derived one in the other", () => {
    expect(customThemeVariantIn(dualDerived, "dark")).toEqual({
      kind: "authored",
      mode: "dark",
      themeVariant: "dark",
    })
    expect(customThemeVariantIn(dualDerived, "light")).toEqual({
      kind: "derived",
      mode: "light",
      themeVariant: "dark",
    })
  })

  it("a hand-authored dual-variant theme is authored in both modes", () => {
    expect(customThemeVariantIn(dualAuthored, "dark").kind).toBe("authored")
    expect(customThemeVariantIn(dualAuthored, "light").kind).toBe("authored")
  })

  it("a single-palette theme is intentionally dormant outside its own mode", () => {
    expect(customThemeVariantIn(legacyDark, "dark").kind).toBe("authored")
    expect(customThemeVariantIn(legacyDark, "light")).toEqual({
      kind: "dormant",
      mode: "light",
      themeVariant: "dark",
    })
    expect(customThemeVariantIn(pluginRegisteredSingle, "light").kind).toBe("dormant")
  })

  it("a row with no recorded variant is dormant in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(customThemeVariantIn(legacyNoVariant, mode)).toEqual({
        kind: "dormant",
        mode,
        themeVariant: null,
      })
    }
  })

  it("reads the base variant with the resolver's precedence", () => {
    expect(customThemeBaseVariant(dualAuthored)).toBe("light")
    expect(customThemeBaseVariant(legacyDark)).toBe("dark")
    expect(customThemeBaseVariant({ id: "d", name: "d", derivedVariant: "dark" })).toBe("light")
    expect(customThemeBaseVariant(legacyNoVariant)).toBeNull()
  })

  // The status is a mirror of `resolveActiveThemeColors`, not a second
  // opinion. Dormant must mean exactly "the resolver painted none of this
  // theme's colors"; every other kind must mean it painted them.
  it.each([
    ["dual derived", dualDerived],
    ["dual authored", dualAuthored],
    ["legacy dark", legacyDark],
    ["legacy without variant", legacyNoVariant],
    ["plugin-registered single palette", pluginRegisteredSingle],
  ])("agrees with the palette resolver for a %s theme", (_label, theme) => {
    for (const mode of ["light", "dark"] as ThemeMode[]) {
      const painted = resolveActiveThemeColors({
        colorTheme: "default",
        resolvedTheme: mode,
        activeCustomThemeId: theme.id,
        customThemes: [theme],
      }).colors.background
      const ownBackgrounds = [theme.tokens?.[mode]?.background, theme.colors?.background].filter(
        Boolean
      )
      const status = customThemeVariantIn(theme, mode)
      if (status.kind === "dormant") {
        expect(ownBackgrounds).not.toContain(painted)
      } else {
        expect(ownBackgrounds).toContain(painted)
      }
    }
  })
})

describe("pluginThemeVariantIn", () => {
  it("matches in its own mode and is painted unchanged in the other", () => {
    expect(pluginThemeVariantIn({ isDark: true }, "dark")).toEqual({
      kind: "authored",
      mode: "dark",
      themeVariant: "dark",
    })
    expect(pluginThemeVariantIn({ isDark: true }, "light")).toEqual({
      kind: "fixed",
      mode: "light",
      themeVariant: "dark",
    })
  })

  it("prefers the declared variant over isDark and tolerates neither", () => {
    expect(pluginThemeVariantIn({ variant: "light", isDark: true }, "light").kind).toBe("authored")
    expect(pluginThemeVariantIn({}, "light")).toEqual({
      kind: "fixed",
      mode: "light",
      themeVariant: null,
    })
  })
})

describe("resolveActiveThemeSummary", () => {
  const plugin = { id: "p.one", name: "Plugin One", isDark: true }
  const base = {
    mode: "light" as const,
    activePluginThemeId: null,
    pluginThemes: [plugin],
    activeCustomThemeId: null,
    customThemes: [dualDerived, legacyDark],
  }

  it("reports nothing when no theme is active", () => {
    expect(resolveActiveThemeSummary(base)).toEqual({ status: null, name: null })
  })

  it("reports the active custom theme in the current mode", () => {
    expect(resolveActiveThemeSummary({ ...base, activeCustomThemeId: "dracula" })).toEqual({
      status: { kind: "derived", mode: "light", themeVariant: "dark" },
      name: "Dracula",
    })
    expect(resolveActiveThemeSummary({ ...base, activeCustomThemeId: "legacy" }).status?.kind).toBe(
      "dormant"
    )
  })

  it("gives a directly activated plugin theme precedence, as the appliers do", () => {
    expect(
      resolveActiveThemeSummary({
        ...base,
        activePluginThemeId: "p.one",
        activeCustomThemeId: "dracula",
      })
    ).toEqual({
      status: { kind: "fixed", mode: "light", themeVariant: "dark" },
      name: "Plugin One",
    })
  })

  it("keeps the name but no status before a mode has resolved", () => {
    expect(
      resolveActiveThemeSummary({ ...base, mode: null, activeCustomThemeId: "dracula" })
    ).toEqual({ status: null, name: "Dracula" })
  })

  it("reports nothing for a pointer to a theme that no longer exists", () => {
    expect(resolveActiveThemeSummary({ ...base, activeCustomThemeId: "gone" })).toEqual({
      status: null,
      name: null,
    })
    expect(resolveActiveThemeSummary({ ...base, activePluginThemeId: "gone" })).toEqual({
      status: null,
      name: null,
    })
  })
})
