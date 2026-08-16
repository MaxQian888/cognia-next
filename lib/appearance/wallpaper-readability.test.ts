/**
 * @jest-environment jsdom
 */
// jsdom: `computeOpacityVerdict` / `readThemeColors` read `--foreground` and
// `--background` off `<html>` via getComputedStyle.
import {
  AA_NORMAL_TEXT,
  bandRatio,
  computeOpacityVerdict,
  effectiveContrast,
  maxOpacityForRatio,
  readThemeColors,
  wallpaperFloorRatio,
} from "./wallpaper-readability"
import type { WallpaperThemeAnalysis } from "./wallpaper-theme-generator"

function analysis(patch: Partial<WallpaperThemeAnalysis> = {}): WallpaperThemeAnalysis {
  return {
    accent: "#3b82f6",
    secondary: "#f68b3b",
    dominant: "#ffffff",
    averageLuminance: 0.9,
    luminanceSpread: 0,
    baseVariant: "light",
    ...patch,
  }
}

function setThemeColors(foreground: string, background: string): void {
  document.documentElement.style.setProperty("--foreground", foreground)
  document.documentElement.style.setProperty("--background", background)
}

afterEach(() => {
  document.documentElement.style.removeProperty("--foreground")
  document.documentElement.style.removeProperty("--background")
})

describe("wallpaperFloorRatio", () => {
  it("assumes the worst for an unsampled image", () => {
    expect(wallpaperFloorRatio({ kind: "image", themeRatio: 21 })).toBe(1.5)
  })

  it("is gentler on unsampled flat sources, whose tone is at least uniform", () => {
    expect(wallpaperFloorRatio({ kind: "gradient", themeRatio: 20 })).toBe(10)
    expect(wallpaperFloorRatio({ kind: "color", themeRatio: 20 })).toBe(10)
  })

  // The whole point of sampling: a flat white wallpaper under black text is
  // perfectly readable, and the blind 1.5 floor said otherwise.
  it("measures a sampled flat wallpaper instead of guessing", () => {
    const floor = wallpaperFloorRatio({
      kind: "image",
      themeRatio: 21,
      foreground: "#000000",
      analysis: analysis({ dominant: "#ffffff", luminanceSpread: 0 }),
    })

    expect(floor).toBeCloseTo(21, 0)
  })

  it("discounts a busy wallpaper back toward the blind floor", () => {
    const calm = wallpaperFloorRatio({
      kind: "image",
      themeRatio: 21,
      foreground: "#000000",
      analysis: analysis({ luminanceSpread: 0.05 }),
    })
    const busy = wallpaperFloorRatio({
      kind: "image",
      themeRatio: 21,
      foreground: "#000000",
      analysis: analysis({ luminanceSpread: 0.5 }),
    })

    expect(busy).toBeLessThan(calm)
    expect(busy).toBeGreaterThanOrEqual(1)
  })

  it("falls back to the blind floor when the sampled color cannot be parsed", () => {
    expect(
      wallpaperFloorRatio({
        kind: "image",
        themeRatio: 21,
        foreground: "#000000",
        analysis: analysis({ dominant: "not-a-color" }),
      })
    ).toBe(1.5)
  })
})

describe("effectiveContrast", () => {
  it("returns the theme ratio at opacity 0 and the floor at opacity 1", () => {
    expect(effectiveContrast(21, 0, 1.5)).toBe(21)
    expect(effectiveContrast(21, 1, 1.5)).toBe(1.5)
  })

  it("interpolates linearly in between and clamps out-of-range opacity", () => {
    expect(effectiveContrast(21, 0.5, 1)).toBeCloseTo(11, 5)
    expect(effectiveContrast(21, -1, 1.5)).toBe(21)
    expect(effectiveContrast(21, 2, 1.5)).toBe(1.5)
  })
})

describe("bandRatio", () => {
  it("bands on the WCAG AA thresholds", () => {
    expect(bandRatio(4.5)).toBe("ok")
    expect(bandRatio(4.49)).toBe("warn")
    expect(bandRatio(3)).toBe("warn")
    expect(bandRatio(2.99)).toBe("fail")
  })
})

describe("maxOpacityForRatio", () => {
  it("allows full opacity when the wallpaper itself clears the target", () => {
    expect(maxOpacityForRatio(21, 6)).toBe(1)
  })

  it("allows none when even the bare theme misses the target", () => {
    expect(maxOpacityForRatio(3, 1.5)).toBe(0)
  })

  it("solves for the highest opacity that still clears AA", () => {
    const opacity = maxOpacityForRatio(21, 1.5)

    expect(effectiveContrast(21, opacity, 1.5)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    // ...and one step further would not.
    expect(effectiveContrast(21, opacity + 0.02, 1.5)).toBeLessThan(AA_NORMAL_TEXT)
  })
})

describe("readThemeColors", () => {
  it("reads the two document colors, with defaults when unset", () => {
    expect(readThemeColors()).toEqual({ foreground: "#000000", background: "#ffffff" })
    setThemeColors("#111111", "#eeeeee")
    expect(readThemeColors()).toEqual({ foreground: "#111111", background: "#eeeeee" })
  })
})

describe("computeOpacityVerdict", () => {
  it("returns null when no wallpaper is active", () => {
    expect(computeOpacityVerdict({ kind: null, opacity: 1 })).toBeNull()
  })

  it("is ok at zero opacity — the wallpaper contributes nothing", () => {
    setThemeColors("#000000", "#ffffff")
    const verdict = computeOpacityVerdict({ kind: "image", opacity: 0 })

    expect(verdict).toMatchObject({ level: "ok", measured: false })
    expect(verdict?.suggestedOpacity).toBeNull()
  })

  it("fails an unsampled image at full opacity and suggests a fix", () => {
    setThemeColors("#000000", "#ffffff")
    const verdict = computeOpacityVerdict({ kind: "image", opacity: 1 })

    expect(verdict?.level).toBe("fail")
    expect(verdict?.suggestedOpacity).toBeGreaterThan(0)
    expect(verdict?.suggestedOpacity).toBeLessThan(1)
  })

  // Previously every image was assumed to be worst-case noise, so a flat photo
  // reported FAIL and the auto-fix threw most of it away for nothing.
  it("passes a sampled flat wallpaper the blind estimate would have failed", () => {
    setThemeColors("#000000", "#ffffff")
    const blind = computeOpacityVerdict({ kind: "image", opacity: 1 })
    const sampled = computeOpacityVerdict({
      kind: "image",
      opacity: 1,
      analysis: analysis({ dominant: "#ffffff", luminanceSpread: 0 }),
    })

    expect(blind?.level).toBe("fail")
    expect(sampled).toMatchObject({ level: "ok", measured: true, suggestedOpacity: null })
  })

  it("survives a theme color culori cannot parse", () => {
    setThemeColors("var(--nope)", "var(--nope)")

    expect(computeOpacityVerdict({ kind: "color", opacity: 0 })?.level).toBe("ok")
  })
})
