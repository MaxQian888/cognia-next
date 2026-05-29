import { paletteColor } from "./chart-palette"
import { DEFAULT_THEME_COLORS } from "@/hooks/logging/use-theme-colors"

describe("paletteColor", () => {
  it("returns chart colors in order", () => {
    expect(paletteColor(DEFAULT_THEME_COLORS, 0)).toBe(DEFAULT_THEME_COLORS["chart-1"])
    expect(paletteColor(DEFAULT_THEME_COLORS, 4)).toBe(DEFAULT_THEME_COLORS["chart-5"])
  })

  it("cycles past the palette length", () => {
    expect(paletteColor(DEFAULT_THEME_COLORS, 5)).toBe(DEFAULT_THEME_COLORS["chart-1"])
  })

  it("handles negative indices", () => {
    expect(paletteColor(DEFAULT_THEME_COLORS, -1)).toBe(DEFAULT_THEME_COLORS["chart-5"])
  })
})
