import { PALETTE_PRESETS, matchPalettePreset } from "./palettes"

describe("palette presets", () => {
  it("exposes a stable, non-empty curated set with oklch palettes", () => {
    expect(PALETTE_PRESETS.length).toBeGreaterThan(0)
    for (const p of PALETTE_PRESETS) {
      expect(p.id).toBeTruthy()
      expect(p.palette.primary).toContain("oklch")
    }
    // ids are unique
    expect(new Set(PALETTE_PRESETS.map((p) => p.id)).size).toBe(PALETTE_PRESETS.length)
  })

  it("matches a palette back to its preset id by primary colour", () => {
    const first = PALETTE_PRESETS[0]
    expect(matchPalettePreset(first.palette)).toBe(first.id)
    expect(matchPalettePreset({ primary: "nope", secondary: "x", accent: "y" })).toBeNull()
    expect(matchPalettePreset(undefined)).toBeNull()
  })
})
