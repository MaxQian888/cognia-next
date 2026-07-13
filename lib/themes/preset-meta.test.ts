import { PRESET_META, PRESET_IDS, PRESET_SWATCHES } from "./preset-meta"
import { COLOR_PRESETS, resolveActiveThemeColors } from "./index"

describe("PRESET_META (single source of truth)", () => {
  it("stays in lockstep with COLOR_PRESETS", () => {
    expect([...PRESET_IDS]).toEqual([...COLOR_PRESETS])
  })

  it("has a unique id per entry and includes the default preset", () => {
    const ids = PRESET_META.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("default")
  })

  it("derives a light+dark swatch (the primary hue) for every preset", () => {
    for (const meta of PRESET_META) {
      expect(PRESET_SWATCHES[meta.id]).toEqual({
        light: meta.light.primary,
        dark: meta.dark.primary,
      })
    }
  })

  it("feeds the resolver: each preset's primary shows up in the resolved palette", () => {
    for (const meta of PRESET_META) {
      const resolvedLight = resolveActiveThemeColors({
        colorTheme: meta.id,
        resolvedTheme: "light",
        activeCustomThemeId: null,
        customThemes: [],
      })
      expect(resolvedLight.colors.primary).toBe(meta.light.primary)
      const resolvedDark = resolveActiveThemeColors({
        colorTheme: meta.id,
        resolvedTheme: "dark",
        activeCustomThemeId: null,
        customThemes: [],
      })
      expect(resolvedDark.colors.primary).toBe(meta.dark.primary)
    }
  })
})
