import { wcagContrast } from "./contrast"
import {
  analyzeWallpaperPixels,
  buildWallpaperTheme,
  type WallpaperThemeAnalysis,
} from "./wallpaper-theme-generator"

function pixels(...rgba: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba.flat())
}

describe("analyzeWallpaperPixels", () => {
  it("extracts a saturated accent and classifies a bright image as light", () => {
    const analysis = analyzeWallpaperPixels(pixels([255, 220, 0, 255], [255, 220, 0, 255]), 2, 1)

    expect(analysis).toEqual({
      accent: "#ffdc00",
      averageLuminance: expect.closeTo(0.83, 2),
      baseVariant: "light",
    })
  })

  it("falls back to the average color for a dark neutral image", () => {
    const analysis = analyzeWallpaperPixels(pixels([24, 32, 48, 255], [24, 32, 48, 255]), 2, 1)

    expect(analysis.accent).toBe("#182030")
    expect(analysis.baseVariant).toBe("dark")
  })

  it("rejects images with no visible pixels", () => {
    expect(() => analyzeWallpaperPixels(pixels([1, 2, 3, 0]), 1, 1)).toThrow(
      "wallpaper contains no visible pixels"
    )
  })

  it("rejects invalid dimensions and incomplete buffers", () => {
    expect(() => analyzeWallpaperPixels(new Uint8ClampedArray(), 0, 1)).toThrow(
      "wallpaper dimensions are invalid"
    )
    expect(() => analyzeWallpaperPixels(new Uint8ClampedArray(3), 1, 1)).toThrow(
      "wallpaper pixel buffer is incomplete"
    )
  })
})

describe("buildWallpaperTheme", () => {
  it("creates complete light and dark palettes with readable accent text", () => {
    const analysis: WallpaperThemeAnalysis = {
      accent: "#f7d154",
      averageLuminance: 0.76,
      baseVariant: "light",
    }

    const theme = buildWallpaperTheme("Golden Hour", analysis)

    expect(theme.name).toBe("Golden Hour")
    expect(theme.baseVariant).toBe("light")
    expect(theme.tokens?.light.primary).toBe("#f7d154")
    expect(theme.tokens?.dark.primary).toBe("#f7d154")
    expect(theme.colors).toEqual(theme.tokens?.light)
    expect(
      wcagContrast(theme.tokens!.light.primaryForeground, theme.tokens!.light.primary)
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      wcagContrast(theme.tokens!.dark.primaryForeground, theme.tokens!.dark.primary)
    ).toBeGreaterThanOrEqual(4.5)
  })
})
