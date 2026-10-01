/**
 * @jest-environment jsdom
 */
// jsdom: `readThemeInk` reads the theme off `<html>` through a probe element.
import {
  AA_NORMAL_TEXT,
  bandRatio,
  computeOpacityVerdict,
  readThemeInk,
} from "./wallpaper-readability"
import { solveMaxImageWeight, type LegibilityInk } from "./wallpaper-legibility"
import type { WallpaperThemeAnalysis } from "./wallpaper-theme-generator"

const LIGHT: LegibilityInk = {
  foreground: "#0a0a0a",
  mutedForeground: "#737373",
  background: "#ffffff",
}

function analysis(patch: Partial<WallpaperThemeAnalysis> = {}): WallpaperThemeAnalysis {
  return {
    accent: "#3b82f6",
    secondary: "#f68b3b",
    dominant: "#ffffff",
    averageLuminance: 0.9,
    luminanceSpread: 0,
    darkExtreme: "#ffffff",
    brightExtreme: "#ffffff",
    baseVariant: "light",
    ...patch,
  }
}

const BUSY = analysis({ dominant: "#808080", darkExtreme: "#101010", brightExtreme: "#f5f5f5" })

function setTheme(foreground: string, muted: string, background: string): void {
  const root = document.documentElement.style
  root.setProperty("--foreground", foreground)
  root.setProperty("--muted-foreground", muted)
  root.setProperty("--background", background)
}

afterEach(() => {
  const root = document.documentElement.style
  root.removeProperty("--foreground")
  root.removeProperty("--muted-foreground")
  root.removeProperty("--background")
})

describe("bandRatio", () => {
  it("bands on the WCAG AA thresholds", () => {
    expect(bandRatio(4.5)).toBe("ok")
    expect(bandRatio(4.49)).toBe("warn")
    expect(bandRatio(3)).toBe("warn")
    expect(bandRatio(2.99)).toBe("fail")
  })
})

describe("readThemeInk", () => {
  it("reads the three document colours", () => {
    setTheme("#111111", "#666666", "#eeeeee")
    expect(readThemeInk()).toEqual({
      foreground: "#111111",
      mutedForeground: "#666666",
      background: "#eeeeee",
      surfaces: [],
    })
  })

  it("reads the translucent surfaces at their live tonality", () => {
    setTheme("#fafafa", "#a1a1a1", "#0a0a0a")
    const root = document.documentElement.style
    root.setProperty("--card", "#171717")
    root.setProperty("--surface-tonality-translucent", "75%")
    root.setProperty("--sidebar", "#171717")
    root.setProperty("--surface-tonality-glass", "60%")
    try {
      expect(readThemeInk()?.surfaces).toEqual([
        { color: "#171717", alpha: 0.75 },
        { color: "#171717", alpha: 0.6 },
      ])
    } finally {
      for (const v of [
        "--card",
        "--surface-tonality-translucent",
        "--sidebar",
        "--surface-tonality-glass",
      ])
        root.removeProperty(v)
    }
  })

  it("leaves out a surface whose tonality is not a percentage", () => {
    setTheme("#fafafa", "#a1a1a1", "#0a0a0a")
    const root = document.documentElement.style
    root.setProperty("--card", "#171717")
    root.setProperty("--surface-tonality-translucent", "calc(nope)")
    try {
      expect(readThemeInk()?.surfaces).toEqual([])
    } finally {
      root.removeProperty("--card")
      root.removeProperty("--surface-tonality-translucent")
    }
  })

  it("returns null rather than guessing when a colour is unreadable", () => {
    setTheme("#111111", "var(--nope)", "#eeeeee")
    expect(readThemeInk()).toBeNull()
  })

  it("is not fooled by a page-wide colour override", () => {
    setTheme("#111111", "#666666", "#eeeeee")
    const style = document.createElement("style")
    style.textContent = "* { color: transparent !important; }"
    document.head.appendChild(style)
    try {
      expect(readThemeInk()?.foreground).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)/)
    } finally {
      style.remove()
    }
  })

  it("treats a fully transparent token as unreadable", () => {
    setTheme("rgba(0, 0, 0, 0)", "#666666", "#eeeeee")
    expect(readThemeInk()).toBeNull()
    setTheme("transparent", "#666666", "#eeeeee")
    expect(readThemeInk()).toBeNull()
  })

  it("leaves no probe element behind", () => {
    setTheme("#111111", "#666666", "#eeeeee")
    const before = document.body.childElementCount
    readThemeInk()
    expect(document.body.childElementCount).toBe(before)
  })
})

describe("computeOpacityVerdict", () => {
  it("returns null when no wallpaper is active or the theme is unreadable", () => {
    expect(computeOpacityVerdict({ kind: null, opacity: 1, ink: LIGHT })).toBeNull()
    expect(computeOpacityVerdict({ kind: "image", opacity: 1, ink: null })).toBeNull()
  })

  it("is ok at zero opacity — the wallpaper contributes nothing", () => {
    const verdict = computeOpacityVerdict({ kind: "image", opacity: 0, ink: LIGHT })

    expect(verdict).toMatchObject({ level: "ok", measured: false, suggestedOpacity: null })
  })

  it("fails an unsampled image at full opacity and suggests the solved cap", () => {
    const verdict = computeOpacityVerdict({ kind: "image", opacity: 1, ink: LIGHT })

    expect(verdict?.level).toBe("fail")
    expect(verdict?.suggestedOpacity).toBe(verdict?.maxWeight)
    expect(verdict?.suggestedOpacity).toBeGreaterThan(0)
    expect(verdict?.suggestedOpacity).toBeLessThan(1)
  })

  // The old linear model rated an image by its mean colour. A black-and-white
  // photo averages to a mid grey and scored far better than the black patch
  // a line of text actually crosses.
  it("rates a busy image by its worst patch, not its mean", () => {
    const verdict = computeOpacityVerdict({
      kind: "image",
      opacity: 1,
      analysis: BUSY,
      ink: LIGHT,
    })
    expect(verdict?.level).toBe("fail")
    expect(verdict?.measured).toBe(true)
  })

  it("passes a sampled wallpaper that matches the theme at full strength", () => {
    const verdict = computeOpacityVerdict({
      kind: "image",
      opacity: 1,
      analysis: analysis(),
      ink: LIGHT,
    })
    expect(verdict).toMatchObject({ level: "ok", maxWeight: 1, suggestedOpacity: null })
  })

  it("reports what the guard actually paints, and offers no manual fix", () => {
    const verdict = computeOpacityVerdict({
      kind: "image",
      opacity: 1,
      analysis: BUSY,
      guard: true,
      ink: LIGHT,
    })
    const max = solveMaxImageWeight({
      ink: LIGHT,
      extremes: { dark: "#101010", bright: "#f5f5f5", mean: "#808080" },
      blurPx: 0,
    })

    expect(verdict).toMatchObject({
      capped: true,
      effectiveOpacity: max,
      level: "ok",
      suggestedOpacity: null,
    })
    expect(verdict?.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it("is not capped when the slider already sits below the guard's limit", () => {
    const verdict = computeOpacityVerdict({
      kind: "image",
      opacity: 0.05,
      analysis: BUSY,
      guard: true,
      ink: LIGHT,
    })
    expect(verdict).toMatchObject({ capped: false, effectiveOpacity: 0.05 })
  })

  it("credits a heavy blur", () => {
    const sharp = computeOpacityVerdict({ kind: "image", opacity: 1, analysis: BUSY, ink: LIGHT })
    const soft = computeOpacityVerdict({
      kind: "image",
      opacity: 1,
      blurPx: 32,
      analysis: BUSY,
      ink: LIGHT,
    })
    expect(soft!.maxWeight).toBeGreaterThan(sharp!.maxWeight)
  })

  it("reads the live theme when no ink is injected", () => {
    setTheme("#0a0a0a", "#737373", "#ffffff")
    const verdict = computeOpacityVerdict({ kind: "image", opacity: 1, analysis: analysis() })
    expect(verdict?.level).toBe("ok")
  })
})
