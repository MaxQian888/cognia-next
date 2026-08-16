import { wcagContrast } from "./contrast"
import { DEFAULT_FALLBACKS } from "./vscode-theme/token-mapping"
import {
  analyzeCssColors,
  analyzeWallpaperPixels,
  buildWallpaperTheme,
  extractCssColorStops,
  recommendBackgroundTuning,
  recommendPosition,
  usableAccent,
  type WallpaperThemeAnalysis,
} from "./wallpaper-theme-generator"

function pixels(...rgba: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba.flat())
}

/** A complete analysis, so each test only states the field it cares about. */
function analysis(patch: Partial<WallpaperThemeAnalysis> = {}): WallpaperThemeAnalysis {
  return {
    accent: "#f7d154",
    secondary: "#54a7f7",
    dominant: "#8c8c8c",
    averageLuminance: 0.76,
    luminanceSpread: 0.1,
    baseVariant: "light",
    ...patch,
  }
}

describe("analyzeWallpaperPixels", () => {
  it("extracts a saturated accent and classifies a bright image as light", () => {
    const result = analyzeWallpaperPixels(pixels([255, 220, 0, 255], [255, 220, 0, 255]), 2, 1)

    // `dominant` is the raw mean — the colour actually behind the text — while
    // `accent` is the same hue pulled into the usable-primary band.
    expect(result).toMatchObject({
      dominant: "#ffdc00",
      averageLuminance: expect.closeTo(0.83, 2),
      baseVariant: "light",
    })
    expect(usableAccent("#ffdc00")).toBe(result.accent)
    // A uniform field has no variance at all.
    expect(result.luminanceSpread).toBeCloseTo(0, 6)
  })

  it("falls back to the average color for a dark neutral image", () => {
    const result = analyzeWallpaperPixels(pixels([24, 32, 48, 255], [24, 32, 48, 255]), 2, 1)

    expect(result.dominant).toBe("#182030")
    expect(result.accent).toBe(usableAccent("#182030"))
    expect(result.baseVariant).toBe("dark")
  })

  it("reports a high luminance spread for a black/white field", () => {
    const flat = analyzeWallpaperPixels(pixels([128, 128, 128, 255], [128, 128, 128, 255]), 2, 1)
    const busy = analyzeWallpaperPixels(pixels([0, 0, 0, 255], [255, 255, 255, 255]), 2, 1)

    expect(flat.luminanceSpread).toBeCloseTo(0, 6)
    expect(busy.luminanceSpread).toBeCloseTo(0.5, 2)
  })

  it("picks a secondary from a hue far away from the accent", () => {
    // Saturated red and saturated cyan — 180° apart.
    const result = analyzeWallpaperPixels(pixels([220, 30, 30, 255], [30, 220, 220, 255]), 2, 1)

    expect(result.accent).not.toBe(result.secondary)
    expect(result.secondary).toMatch(/^#[0-9a-f]{6}$/)
  })

  it("synthesizes a secondary by hue rotation for a single-hue image", () => {
    const result = analyzeWallpaperPixels(pixels([220, 30, 30, 255], [200, 40, 40, 255]), 2, 1)

    expect(result.secondary).toMatch(/^#[0-9a-f]{6}$/)
    expect(result.secondary).not.toBe(result.accent)
  })

  it("ignores pixels below the visible-alpha floor", () => {
    const result = analyzeWallpaperPixels(pixels([255, 0, 0, 10], [0, 0, 255, 255]), 2, 1)

    expect(result.dominant).toBe("#0000ff")
  })

  // Exercises each channel maximum, including the magenta case whose raw hue
  // comes out negative and has to wrap into 0..360 before it can be compared.
  it("handles hues dominated by any channel, including the negative-wrap case", () => {
    const magentaAndGreen = analyzeWallpaperPixels(
      pixels([220, 20, 120, 255], [20, 220, 40, 255]),
      2,
      1
    )
    const blueAndYellow = analyzeWallpaperPixels(
      pixels([20, 60, 220, 255], [220, 200, 20, 255]),
      2,
      1
    )

    for (const result of [magentaAndGreen, blueAndYellow]) {
      expect(result.accent).toMatch(/^#[0-9a-f]{6}$/)
      expect(result.secondary).toMatch(/^#[0-9a-f]{6}$/)
      expect(result.luminanceSpread).toBeGreaterThan(0)
    }
  })

  it("synthesizes a secondary for a pure gray image, which has no hue at all", () => {
    const result = analyzeWallpaperPixels(pixels([128, 128, 128, 255], [128, 128, 128, 255]), 2, 1)

    // Mid-gray is already inside the accent band, so it survives untouched.
    expect(result.accent).toBe("#808080")
    expect(result.secondary).toMatch(/^#[0-9a-f]{6}$/)
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

describe("usableAccent", () => {
  it("leaves a mid-lightness colour exactly as it is", () => {
    expect(usableAccent("#ff2d95")).toBe("#ff2d95")
    expect(usableAccent("#3b5bb5")).toBe("#3b5bb5")
  })

  // A near-black or near-white accent makes an unreadable primary button, so
  // the hue is kept and only the lightness moves.
  it("lifts a near-black and drops a near-white into the usable band", () => {
    const lifted = usableAccent("#0f172a")
    const dropped = usableAccent("#fafaf9")

    expect(lifted).not.toBe("#0f172a")
    expect(dropped).not.toBe("#fafaf9")
    expect(wcagContrast(lifted, "#ffffff")).toBeGreaterThan(3)
    expect(wcagContrast(dropped, "#000000")).toBeGreaterThan(3)
  })

  it("returns an unparsable input untouched", () => {
    expect(usableAccent("nope")).toBe("nope")
  })
})

describe("extractCssColorStops", () => {
  it("keeps the color stops and drops the geometry terms", () => {
    expect(extractCssColorStops("linear-gradient(135deg, #667eea 0%, #764ba2 100%)")).toEqual([
      "#667eea",
      "#764ba2",
    ])
  })

  it("drops fully transparent stops, which carry no color", () => {
    const css =
      "radial-gradient(circle at 30% 20%, #4f46e5 0%, transparent 40%), linear-gradient(135deg, #0f172a 0%, #1e293b 100%)"

    expect(extractCssColorStops(css)).toEqual(["#4f46e5", "#0f172a", "#1e293b"])
  })

  it("understands functional color notations", () => {
    expect(
      extractCssColorStops("linear-gradient(to right, rgb(255 0 0), oklch(0.5 0.1 30))")
    ).toEqual(["rgb(255 0 0)", "oklch(0.5 0.1 30)"])
  })

  it("returns nothing when the declaration has no parsable color", () => {
    expect(extractCssColorStops("linear-gradient(to bottom)")).toEqual([])
  })

  it("returns nothing for a declaration with no tokens at all", () => {
    expect(extractCssColorStops("")).toEqual([])
    expect(extractCssColorStops("  ")).toEqual([])
  })
})

describe("analyzeCssColors", () => {
  it("analyzes a gradient's stops the same way it would a raster", () => {
    const result = analyzeCssColors(["#000000", "#ffffff"])

    expect(result.luminanceSpread).toBeCloseTo(0.5, 2)
    expect(result.dominant).toBe("#808080")
  })

  it("treats a solid color as a flat field", () => {
    const result = analyzeCssColors(["#1f2937"])

    expect(result.luminanceSpread).toBeCloseTo(0, 6)
    expect(result.baseVariant).toBe("dark")
  })

  it("rejects a list with nothing parsable in it", () => {
    expect(() => analyzeCssColors(["not-a-color"])).toThrow("wallpaper contains no visible pixels")
  })

  // Averaging every saturated stop made a two-tone wallpaper produce two nearly
  // identical swatches — the blend of magenta and cyan is a purple that appears
  // nowhere in the image. The hue histogram keeps the families apart.
  it("keeps the two families of a two-tone gradient distinct", () => {
    const neonCity = analyzeCssColors(
      extractCssColorStops(
        "radial-gradient(ellipse at 25% 85%, #ff2d95 0%, transparent 45%), radial-gradient(ellipse at 78% 20%, #22d3ee 0%, transparent 42%), linear-gradient(180deg, #0b0a12 0%, #1a1730 100%)"
      )
    )

    expect(neonCity.accent).toBe("#ff2d95")
    expect(neonCity.secondary).toMatch(/^#[0-9a-f]{6}$/)
    // Magenta ≈ 330°, cyan ≈ 190° — the two swatches must not converge.
    expect(neonCity.secondary).not.toBe(neonCity.accent)
    expect(neonCity.baseVariant).toBe("dark")
  })

  // A wallpaper whose dominant family is near-black must not hand the UI a
  // near-black primary.
  it("lifts a dark-dominant wallpaper's accent into the usable band", () => {
    const yozora = analyzeCssColors(
      extractCssColorStops(
        "radial-gradient(circle at 80% 12%, #ffd166 0%, transparent 22%), radial-gradient(circle at 30% 40%, #3b5bb5 0%, transparent 50%), linear-gradient(180deg, #0d1330 0%, #060a1e 100%)"
      )
    )

    expect(yozora.accent).toBe(usableAccent(yozora.accent))
    expect(wcagContrast(yozora.accent, "#ffffff")).toBeGreaterThan(3)
  })
})

describe("recommendBackgroundTuning", () => {
  it("leaves a flat gradient at full strength and adds no blur", () => {
    expect(recommendBackgroundTuning(analysis({ luminanceSpread: 0 }), "gradient")).toEqual({
      opacity: 1,
      blurPx: 0,
    })
  })

  it("pulls a busy image down in opacity and up in blur", () => {
    const calm = recommendBackgroundTuning(analysis({ luminanceSpread: 0.05 }), "image")
    const busy = recommendBackgroundTuning(analysis({ luminanceSpread: 0.45 }), "image")

    expect(busy.opacity).toBeLessThan(calm.opacity)
    expect(busy.blurPx).toBeGreaterThan(calm.blurPx)
    expect(busy.opacity).toBeGreaterThanOrEqual(0.25)
    expect(busy.blurPx).toBeLessThanOrEqual(16)
  })
})

describe("recommendPosition", () => {
  it("keeps window-shaped images on cover", () => {
    expect(recommendPosition(1920, 1080)).toBe("cover")
    expect(recommendPosition(1000, 1000)).toBe("cover")
  })

  it("switches ultra-wide and portrait images to contain", () => {
    expect(recommendPosition(5120, 1440)).toBe("contain")
    expect(recommendPosition(1080, 1920)).toBe("contain")
  })

  it("falls back to cover for unusable dimensions", () => {
    expect(recommendPosition(0, 0)).toBe("cover")
    expect(recommendPosition(Number.NaN, 100)).toBe("cover")
  })
})

describe("buildWallpaperTheme", () => {
  it("creates complete light and dark palettes with readable accent text", () => {
    const theme = buildWallpaperTheme("Golden Hour", analysis())

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

  it("tints the neutral surfaces toward the wallpaper instead of leaving them gray", () => {
    const theme = buildWallpaperTheme("Golden Hour", analysis())

    expect(theme.tokens!.light.background).not.toBe(DEFAULT_FALLBACKS.light.background)
    expect(theme.tokens!.light.border).not.toBe(DEFAULT_FALLBACKS.light.border)
    expect(theme.tokens!.dark.card).not.toBe(DEFAULT_FALLBACKS.dark.card)
  })

  it("keeps every tinted surface readable against its own foreground", () => {
    const theme = buildWallpaperTheme("Golden Hour", analysis({ baseVariant: "dark" }))

    for (const variant of ["light", "dark"] as const) {
      const tokens = theme.tokens![variant]
      expect(wcagContrast(tokens.foreground, tokens.background)).toBeGreaterThanOrEqual(4.5)
      expect(wcagContrast(tokens.cardForeground, tokens.card)).toBeGreaterThanOrEqual(4.5)
      expect(wcagContrast(tokens.mutedForeground, tokens.muted)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("leaves the palette alone when the accent cannot be parsed", () => {
    const theme = buildWallpaperTheme("Broken", analysis({ accent: "nope", secondary: "nope" }))

    expect(theme.tokens!.light.background).toBe(DEFAULT_FALLBACKS.light.background)
  })

  // A gray accent has no hue to rotate onto, so there is nothing to tint —
  // but the accent tokens themselves must still be applied.
  it("skips the tint for a hueless accent while still applying it", () => {
    const theme = buildWallpaperTheme(
      "Concrete",
      analysis({ accent: "#808080", secondary: "#808080" })
    )

    expect(theme.tokens!.light.primary).toBe("#808080")
    expect(theme.tokens!.light.background).toBe(DEFAULT_FALLBACKS.light.background)
  })
})
