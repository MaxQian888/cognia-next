// Readability model for the wallpaper layer.
//
// The wallpaper sits *behind* the UI at `--app-bg-opacity`, so the contrast the
// user actually experiences is somewhere between the theme's own
// foreground/background ratio (opacity 0) and whatever the wallpaper itself
// offers (opacity 1). This module owns that interpolation, the WCAG banding,
// and the inverse solve the "auto-fix" button needs.
//
// Previously this lived inline in `wallpaper-tab.tsx` and treated every image
// as worst-case noise (1.5:1). Once `wallpaper-theme-generator` has actually
// sampled the image we know its mean luminance and how busy it is, so the
// estimate stops being a guess — see {@link wallpaperFloorRatio}.

import { isColorParsable, wcagContrast } from "./contrast"
import { AA_NORMAL_TEXT } from "./ensure-contrast"
import type { WallpaperThemeAnalysis } from "./wallpaper-theme-generator"

/** WCAG 2.1 AA for normal text; the band the UI calls "ok". Re-exported so the
 * wallpaper UI has one import for the whole readability model. */
export { AA_NORMAL_TEXT }
/** WCAG 2.1 AA for large text; the floor of the "warn" band. */
export const AA_LARGE_TEXT = 3

export type ReadabilityBand = "ok" | "warn" | "fail"

export interface ReadabilityVerdict {
  level: ReadabilityBand
  ratio: number
}

/** Blind worst case for an unsampled image: assume the busiest possible field. */
const UNSAMPLED_IMAGE_FLOOR = 1.5

export type WallpaperKind = "image" | "gradient" | "color"

/**
 * Contrast the text would keep if the wallpaper were fully opaque.
 *
 * Without an analysis we can only assume the worst for images (an unsampled
 * photo may put anything behind the text) while gradients and solid colors get
 * a gentler estimate — their tone is at least uniform, so half the theme's
 * ratio survives.
 *
 * With an analysis we can do better: measure the sampled wallpaper against the
 * text color the active theme is using, then discount by how much the image
 * varies (`luminanceSpread`). A flat navy field keeps nearly all of its
 * measured ratio; a high-contrast photo collapses toward the blind floor,
 * because *somewhere* in that image is a patch that defeats the text.
 */
export function wallpaperFloorRatio(args: {
  kind: WallpaperKind
  /** The theme's own foreground/background ratio, i.e. contrast at opacity 0. */
  themeRatio: number
  /** Resolved `--foreground`, when it could be read off the document. */
  foreground?: string
  analysis?: WallpaperThemeAnalysis | null
}): number {
  const { kind, themeRatio, foreground, analysis } = args
  const blind = (): number => (kind === "image" ? UNSAMPLED_IMAGE_FLOOR : themeRatio * 0.5)
  if (!analysis || !foreground) return blind()
  if (!isColorParsable(foreground) || !isColorParsable(analysis.dominant)) return blind()
  const measured = wcagContrast(foreground, analysis.dominant)
  // `luminanceSpread` is a 0..1 std-dev of per-pixel luminance. Even a
  // perfectly flat image gets a small haircut — antialiased text over a
  // photographic surface reads worse than the same ratio over a flat fill.
  const busyness = Math.max(0, Math.min(1, analysis.luminanceSpread))
  const discounted = measured * (1 - busyness) + UNSAMPLED_IMAGE_FLOOR * busyness
  return Math.max(1, Math.min(measured, discounted))
}

/**
 * Linear blend between the theme's own ratio (opacity 0) and the wallpaper
 * floor (opacity 1). Linear because the wallpaper layer composites linearly in
 * `opacity` — modelling it any more precisely would need the actual per-pixel
 * composite, which is what {@link wallpaperFloorRatio}'s analysis path already
 * approximates.
 */
export function effectiveContrast(themeRatio: number, opacity: number, floorRatio: number): number {
  const clamped = Math.max(0, Math.min(1, opacity))
  return themeRatio * (1 - clamped) + floorRatio * clamped
}

export function bandRatio(ratio: number): ReadabilityBand {
  if (ratio >= AA_NORMAL_TEXT) return "ok"
  if (ratio >= AA_LARGE_TEXT) return "warn"
  return "fail"
}

/**
 * Largest opacity that still reaches `target`, given the same linear model.
 *
 * Solving `themeRatio·(1-o) + floor·o = target` for `o`. Returns 1 when the
 * wallpaper is readable at any opacity, and 0 when even the bare theme misses
 * the target (nothing the opacity slider can do will help). The result is
 * floored to 2 decimals so the slider lands on a round number and the value we
 * persist is the one the user sees.
 */
export function maxOpacityForRatio(
  themeRatio: number,
  floorRatio: number,
  target: number = AA_NORMAL_TEXT
): number {
  if (floorRatio >= target) return 1
  if (themeRatio <= target) return 0
  const solved = (themeRatio - target) / (themeRatio - floorRatio)
  return Math.max(0, Math.min(1, Math.floor(solved * 100) / 100))
}

/** The two document colors the verdict depends on. Null outside the browser. */
export function readThemeColors(): { foreground: string; background: string } | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null
  const cs = getComputedStyle(document.documentElement)
  return {
    foreground: cs.getPropertyValue("--foreground").trim() || "#000000",
    background: cs.getPropertyValue("--background").trim() || "#ffffff",
  }
}

export interface OpacityVerdictArgs {
  kind: WallpaperKind | null
  opacity: number
  analysis?: WallpaperThemeAnalysis | null
}

export interface OpacityVerdict extends ReadabilityVerdict {
  /** Opacity the auto-fix button would apply; null when already `ok`. */
  suggestedOpacity: number | null
  /** True when the estimate used real sampled pixels rather than the blind floor. */
  measured: boolean
}

/**
 * Live readability verdict for the wallpaper opacity guard. Reads
 * `--foreground` / `--background` off `<html>` because the effective text color
 * depends on the active theme, which lives in CSS-only state. Returns null on
 * SSR or when no wallpaper is active.
 */
export function computeOpacityVerdict(args: OpacityVerdictArgs): OpacityVerdict | null {
  const { kind, opacity, analysis } = args
  if (kind === null) return null
  const colors = readThemeColors()
  if (!colors) return null

  // A CSS variable can resolve to something culori has no parser for (or, in
  // a test environment, to nothing at all). Treating that as 1:1 would flash a
  // FAIL chip at the user over a theme that is perfectly fine, so fall back to
  // the maximum ratio and let the wallpaper floor do the talking.
  const parsable = isColorParsable(colors.foreground) && isColorParsable(colors.background)
  const themeRatio = parsable ? wcagContrast(colors.foreground, colors.background) : 21

  const floorRatio = wallpaperFloorRatio({
    kind,
    themeRatio,
    foreground: colors.foreground,
    analysis,
  })
  const ratio = effectiveContrast(themeRatio, opacity, floorRatio)
  const level = bandRatio(ratio)
  return {
    level,
    ratio,
    suggestedOpacity: level === "ok" ? null : maxOpacityForRatio(themeRatio, floorRatio),
    measured: Boolean(analysis),
  }
}
