import { STYLE_PRESETS, getStylePreset } from "./style-presets"
import { THEMES } from "./syntax-themes"
import type { ThemeId } from "./syntax-themes"

describe("STYLE_PRESETS", () => {
  const presetIds = Object.keys(STYLE_PRESETS) as ThemeId[]

  it("covers every theme id (all themes ship decorative chrome)", () => {
    expect(new Set(presetIds)).toEqual(new Set(Object.keys(THEMES)))
    for (const id of presetIds) {
      expect(THEMES[id]).toBeDefined()
    }
  })

  it("every preset produces CSS containing its theme accent", () => {
    for (const id of presetIds) {
      const css = STYLE_PRESETS[id]!.css(THEMES[id])
      expect(css.length).toBeGreaterThan(0)
      expect(css).toContain(".preset-banner")
    }
  })

  it("arknights preset carries banner and footer chrome", () => {
    const preset = STYLE_PRESETS.arknights!
    expect(preset.bannerText).toBe("TACTICAL COMMUNICATION LOG")
    expect(preset.footerText).toContain("PRTS")
    // grid background derives a translucent hairline from the accent
    expect(preset.css(THEMES.arknights)).toContain("rgba(")
  })

  it("falls back to opaque-safe hairline for non-hex accents", () => {
    const css = STYLE_PRESETS.arknights!.css({ ...THEMES.arknights, accent: "not-a-color" })
    expect(css).toContain("rgba(128,128,128,0.2)")
  })
})

describe("getStylePreset", () => {
  it("returns the preset for styled themes", () => {
    expect(getStylePreset("arknights")).toBe(STYLE_PRESETS.arknights)
    expect(getStylePreset("light")).toBe(STYLE_PRESETS.light)
  })

  it("returns undefined for undefined input", () => {
    expect(getStylePreset(undefined)).toBeUndefined()
  })
})
