import {
  BLIND_EXTREMES,
  FOREGROUND_TARGET,
  MUTED_TARGET,
  blurShrink,
  extremesOf,
  formatMaxWeight,
  isLegibilityGuardOn,
  NEUTRAL_DARK_INK,
  NEUTRAL_LIGHT_INK,
  THEME_MISMATCH_GAIN,
  recommendThemeVariant,
  solveMaxImageWeight,
  themeMismatch,
  worstForegroundContrast,
  type LegibilityInk,
  type WallpaperExtremes,
} from "./wallpaper-legibility"
import type { WallpaperThemeAnalysis } from "./wallpaper-theme-generator"

// The default theme's resolved colours (globals.css :root / .dark).
const LIGHT: LegibilityInk = {
  foreground: "#0a0a0a",
  mutedForeground: "#737373",
  background: "#ffffff",
}
const DARK: LegibilityInk = {
  foreground: "#fafafa",
  mutedForeground: "#a1a1a1",
  background: "#0a0a0a",
}

function flat(color: string): WallpaperExtremes {
  return { dark: color, bright: color, mean: color }
}

const BUSY: WallpaperExtremes = { dark: "#101010", bright: "#f5f5f5", mean: "#808080" }

describe("solveMaxImageWeight", () => {
  it("lets a wallpaper that matches the theme show at full strength", () => {
    expect(solveMaxImageWeight({ ink: LIGHT, extremes: flat("#f4f4f5"), blurPx: 0 })).toBe(1)
    expect(solveMaxImageWeight({ ink: DARK, extremes: flat("#0b1020"), blurPx: 0 })).toBe(1)
  })

  it("dims a wallpaper that fights the theme", () => {
    // Dark navy under dark text: most of it has to go.
    const weight = solveMaxImageWeight({ ink: LIGHT, extremes: flat("#0b1020"), blurPx: 0 })
    expect(weight).toBeGreaterThan(0)
    expect(weight).toBeLessThan(0.5)
  })

  it("bounds a busy field in both themes without blanking it", () => {
    // A black-and-white photo is the hardest case there is; it still keeps a
    // visible share of the image rather than collapsing to the theme colour.
    for (const ink of [LIGHT, DARK]) {
      const weight = solveMaxImageWeight({ ink, extremes: BUSY, blurPx: 0 })
      expect(weight).toBeGreaterThanOrEqual(0.15)
      expect(weight).toBeLessThan(0.5)
    }
  })

  it("keeps a dark wallpaper vivid under a dark theme and a light one under a light theme", () => {
    const night: WallpaperExtremes = { dark: "#0b1020", bright: "#3b1d4a", mean: "#1f1a30" }
    const paper: WallpaperExtremes = { dark: "#f4f4f5", bright: "#ffffff", mean: "#fafafa" }
    expect(solveMaxImageWeight({ ink: DARK, extremes: night, blurPx: 0 })).toBe(1)
    expect(solveMaxImageWeight({ ink: LIGHT, extremes: paper, blurPx: 0 })).toBe(1)
    // …and dims each heavily under the opposite theme.
    expect(solveMaxImageWeight({ ink: LIGHT, extremes: night, blurPx: 0 })).toBeLessThan(0.3)
    expect(solveMaxImageWeight({ ink: DARK, extremes: paper, blurPx: 0 })).toBeLessThan(0.4)
  })

  it("holds both targets at the weight it returns", () => {
    for (const ink of [LIGHT, DARK]) {
      const weight = solveMaxImageWeight({ ink, extremes: BUSY, blurPx: 0 })
      expect(
        worstForegroundContrast({ ink, extremes: BUSY, blurPx: 0, weight })
      ).toBeGreaterThanOrEqual(FOREGROUND_TARGET)
      // One step further must break a target, or the solver stopped early.
      const next = weight + 0.01
      const fgBeyond = worstForegroundContrast({ ink, extremes: BUSY, blurPx: 0, weight: next })
      const mutedBeyond = worstForegroundContrast({
        ink: { ...ink, foreground: ink.mutedForeground },
        extremes: BUSY,
        blurPx: 0,
        weight: next,
      })
      expect(fgBeyond < FOREGROUND_TARGET || mutedBeyond < MUTED_TARGET).toBe(true)
    }
  })

  it("credits a heavy wallpaper blur and ignores a light one", () => {
    const sharp = solveMaxImageWeight({ ink: LIGHT, extremes: BUSY, blurPx: 0 })
    expect(solveMaxImageWeight({ ink: LIGHT, extremes: BUSY, blurPx: 12 })).toBe(sharp)
    expect(solveMaxImageWeight({ ink: LIGHT, extremes: BUSY, blurPx: 32 })).toBeGreaterThan(sharp)
  })

  it("caps its targets at what the bare theme achieves", () => {
    // Muted text at ~2:1 on its own background can never reach 3:1 over an
    // image. An uncapped target would pin every wallpaper to weight 0.
    const faint: LegibilityInk = { ...LIGHT, mutedForeground: "#a8a8a8" }
    expect(solveMaxImageWeight({ ink: faint, extremes: flat("#fafafa"), blurPx: 0 })).toBe(1)
    expect(
      solveMaxImageWeight({ ink: faint, extremes: flat("#d4d4d8"), blurPx: 0 })
    ).toBeGreaterThan(0)
  })

  it("flattens translucent text onto the backdrop before measuring", () => {
    const opaque = solveMaxImageWeight({ ink: LIGHT, extremes: BUSY, blurPx: 0 })
    const translucent = solveMaxImageWeight({
      ink: { ...LIGHT, mutedForeground: "rgb(115 115 115 / 0.7)" },
      extremes: BUSY,
      blurPx: 0,
    })
    expect(translucent).toBeLessThanOrEqual(opaque)
  })

  it("assumes the worst without an analysis", () => {
    const blind = solveMaxImageWeight({ ink: LIGHT, extremes: BLIND_EXTREMES, blurPx: 0 })
    expect(blind).toBeLessThanOrEqual(
      solveMaxImageWeight({ ink: LIGHT, extremes: BUSY, blurPx: 0 })
    )
  })

  it("does not guard on colours it cannot read", () => {
    expect(
      solveMaxImageWeight({
        ink: { ...LIGHT, foreground: "var(--nope)" },
        extremes: BUSY,
        blurPx: 0,
      })
    ).toBe(1)
  })
})

describe("worstForegroundContrast", () => {
  it("is the theme's own ratio at weight 0 and falls as the image shows", () => {
    const at0 = worstForegroundContrast({ ink: LIGHT, extremes: BUSY, blurPx: 0, weight: 0 })
    const at1 = worstForegroundContrast({ ink: LIGHT, extremes: BUSY, blurPx: 0, weight: 1 })
    expect(at0).toBeCloseTo(19.8, 0)
    expect(at1).toBeLessThan(1.5)
  })

  it("reports the maximum for unreadable input rather than a false alarm", () => {
    expect(
      worstForegroundContrast({
        ink: { ...LIGHT, background: "nonsense" },
        extremes: BUSY,
        blurPx: 0,
        weight: 1,
      })
    ).toBe(21)
  })
})

describe("blurShrink", () => {
  it("gives no credit up to the raster's own averaging", () => {
    expect(blurShrink(0)).toBe(1)
    expect(blurShrink(15)).toBe(1)
    expect(blurShrink(Number.NaN)).toBe(1)
  })

  it("shrinks extremes in proportion beyond it", () => {
    expect(blurShrink(30)).toBeCloseTo(0.5, 6)
    expect(blurShrink(32)).toBeLessThan(blurShrink(20))
  })
})

describe("extremesOf", () => {
  it("falls back to the blind field without an analysis", () => {
    expect(extremesOf(null)).toBe(BLIND_EXTREMES)
    expect(extremesOf(undefined)).toBe(BLIND_EXTREMES)
  })

  it("reads the percentile extremes and the mean off an analysis", () => {
    const analysis = {
      accent: "#3b82f6",
      secondary: "#f63b82",
      dominant: "#777777",
      averageLuminance: 0.5,
      luminanceSpread: 0.3,
      darkExtreme: "#111111",
      brightExtreme: "#eeeeee",
      baseVariant: "dark",
    } satisfies WallpaperThemeAnalysis
    expect(extremesOf(analysis)).toEqual({ dark: "#111111", bright: "#eeeeee", mean: "#777777" })
  })
})

describe("formatMaxWeight", () => {
  it("clamps and trims to three decimals", () => {
    expect(formatMaxWeight(0.12345)).toBe("0.123")
    expect(formatMaxWeight(1.5)).toBe("1")
    expect(formatMaxWeight(-0.2)).toBe("0")
  })

  it("refuses values that would invalidate the CSS min() reading it", () => {
    expect(formatMaxWeight(Number.NaN)).toBeNull()
    expect(formatMaxWeight(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe("isLegibilityGuardOn", () => {
  it("treats a row written before the guard existed as ON", () => {
    expect(isLegibilityGuardOn({})).toBe(true)
    expect(isLegibilityGuardOn({ legibilityGuard: true })).toBe(true)
  })

  it("is off only when the user turned it off", () => {
    expect(isLegibilityGuardOn({ legibilityGuard: false })).toBe(false)
  })
})

describe("translucent surfaces over the wallpaper", () => {
  // The default dark theme's card (oklch 0.205) is lighter than its page
  // ground (oklch 0.145); light theme card and ground are the same white.
  const DARK_CARD = { color: "#171717", alpha: 0.75 }

  it("changes nothing when the surface matches the ground", () => {
    const base = solveMaxImageWeight({ ink: LIGHT, extremes: BUSY, blurPx: 0 })
    const withCard = solveMaxImageWeight({
      ink: { ...LIGHT, surfaces: [{ color: "#ffffff", alpha: 0.7 }] },
      extremes: BUSY,
      blurPx: 0,
    })
    expect(withCard).toBe(base)
  })

  it("never lets a surface loosen the cap the ground set", () => {
    const base = solveMaxImageWeight({ ink: DARK, extremes: BUSY, blurPx: 0 })
    const withCard = solveMaxImageWeight({
      ink: { ...DARK, surfaces: [DARK_CARD] },
      extremes: BUSY,
      blurPx: 0,
    })
    expect(withCard).toBeLessThanOrEqual(base)
  })

  it("tightens the cap when a surface holds text to a stricter target", () => {
    // A grey page ground on which muted text is natively invisible, so its own
    // target is capped near 1:1 — and a near-white card on which the same text
    // is natively readable, so the card is held to a real target. The cap must
    // follow the card, not the ground.
    const ink: LegibilityInk = {
      foreground: "#000000",
      mutedForeground: "#a1a1a1",
      background: "#a5a5a5",
    }
    const card = { color: "#f0f0f0", alpha: 0.75 }
    const base = solveMaxImageWeight({ ink, extremes: BUSY, blurPx: 0 })
    const withCard = solveMaxImageWeight({
      ink: { ...ink, surfaces: [card] },
      extremes: BUSY,
      blurPx: 0,
    })
    expect(withCard).toBeLessThan(base)
  })

  it("leaves the default dark theme's cap alone — its cards never bind", () => {
    const base = solveMaxImageWeight({ ink: DARK, extremes: BUSY, blurPx: 0 })
    expect(
      solveMaxImageWeight({
        ink: {
          ...DARK,
          surfaces: [
            { color: "#171717", alpha: 0.75 },
            { color: "#171717", alpha: 0.6 },
          ],
        },
        extremes: BUSY,
        blurPx: 0,
      })
    ).toBe(base)
  })

  it("measures a translucent surface against itself over the page, not as if opaque", () => {
    // Light text on a black page under a slightly lighter translucent card. Measured opaque, the card's target
    // would sit above what it shows at weight 0 and fail before any image.
    const ink: LegibilityInk = {
      foreground: "#ffffff",
      mutedForeground: "#a1a1a1",
      background: "#000000",
    }
    expect(
      solveMaxImageWeight({
        ink: { ...ink, surfaces: [{ color: "#1e1e1e", alpha: 0.6 }] },
        extremes: BUSY,
        blurPx: 0,
      })
    ).toBeGreaterThan(0)
  })

  it("reports the worst reader across every ground", () => {
    const ink: LegibilityInk = {
      foreground: "#000000",
      mutedForeground: "#666666",
      background: "#ffffff",
    }
    const dim = { color: "#bdbdbd", alpha: 0.9 }
    const ground = worstForegroundContrast({ ink, extremes: BUSY, blurPx: 0, weight: 0.2 })
    const stacked = worstForegroundContrast({
      ink: { ...ink, surfaces: [dim] },
      extremes: BUSY,
      blurPx: 0,
      weight: 0.2,
    })
    expect(stacked).toBeLessThan(ground)
  })

  it("ignores a surface it cannot read instead of abandoning the solve", () => {
    const base = solveMaxImageWeight({ ink: DARK, extremes: BUSY, blurPx: 0 })
    expect(
      solveMaxImageWeight({
        ink: {
          ...DARK,
          surfaces: [
            { color: "var(--nope)", alpha: 0.7 },
            { color: "#171717", alpha: Number.NaN },
          ],
        },
        extremes: BUSY,
        blurPx: 0,
      })
    ).toBe(base)
  })

  it("treats a fully opaque surface as its own ground", () => {
    // Reduced transparency pushes every tier to 100%: the wallpaper cannot
    // reach text on the card at all, so only the page ground can bind.
    const base = solveMaxImageWeight({ ink: DARK, extremes: BUSY, blurPx: 0 })
    expect(
      solveMaxImageWeight({
        ink: { ...DARK, surfaces: [{ color: "#171717", alpha: 1 }] },
        extremes: BUSY,
        blurPx: 0,
      })
    ).toBe(base)
  })
})

describe("recommendThemeVariant", () => {
  const night: WallpaperExtremes = { dark: "#05060a", bright: "#2a2f45", mean: "#141826" }
  const paper: WallpaperExtremes = { dark: "#e7e5e4", bright: "#ffffff", mean: "#f5f5f4" }

  it("picks dark for a night sky and light for paper", () => {
    expect(recommendThemeVariant({ extremes: night, blurPx: 0 }).recommended).toBe("dark")
    expect(recommendThemeVariant({ extremes: paper, blurPx: 0 }).recommended).toBe("light")
  })

  it("reports the weight each variant would allow", () => {
    const fit = recommendThemeVariant({ extremes: night, blurPx: 0 })
    expect(fit.weights.dark).toBe(
      solveMaxImageWeight({ ink: NEUTRAL_DARK_INK, extremes: night, blurPx: 0 })
    )
    expect(fit.weights.light).toBe(
      solveMaxImageWeight({ ink: NEUTRAL_LIGHT_INK, extremes: night, blurPx: 0 })
    )
    expect(fit.weights.dark).toBeGreaterThan(fit.weights.light)
  })

  it("breaks a tie by where the field sits against equal-contrast grey", () => {
    // Both variants show a flat mid-tone at the same weight; its luminance
    // decides.
    const lightish = flat("#a0a0a0")
    const darkish = flat("#505050")
    const a = recommendThemeVariant({ extremes: lightish, blurPx: 0 })
    const b = recommendThemeVariant({ extremes: darkish, blurPx: 0 })
    if (a.weights.light === a.weights.dark) expect(a.recommended).toBe("light")
    if (b.weights.light === b.weights.dark) expect(b.recommended).toBe("dark")
  })

  it("judges by legibility, not by the average", () => {
    // Mostly bright with hard black patches: the mean is light, but dark
    // text over those patches fails sooner than light text over the bright.
    const fit = recommendThemeVariant({
      extremes: { dark: "#000000", bright: "#d4d4d4", mean: "#a3a3a3" },
      blurPx: 0,
    })
    expect(fit.weights[fit.recommended]).toBeGreaterThanOrEqual(
      Math.max(fit.weights.light, fit.weights.dark)
    )
  })
})

describe("themeMismatch", () => {
  it("names the better variant only when it shows meaningfully more image", () => {
    expect(
      themeMismatch({ recommended: "dark", weights: { light: 0.2, dark: 0.9 } }, "light")
    ).toBe("dark")
    expect(
      themeMismatch(
        { recommended: "dark", weights: { light: 0.5, dark: 0.5 + THEME_MISMATCH_GAIN / 2 } },
        "light"
      )
    ).toBeNull()
  })

  it("is silent when the current variant is already the recommendation", () => {
    expect(
      themeMismatch({ recommended: "light", weights: { light: 1, dark: 0.1 } }, "light")
    ).toBeNull()
  })
})
