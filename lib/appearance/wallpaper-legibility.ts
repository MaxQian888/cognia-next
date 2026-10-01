// Wallpaper legibility solver.
//
// The wallpaper layer paints at `opacity` over the theme's `--background`, and
// every piece of text that is not inside a surface of its own reads straight
// against that composite. So the question the guard has to answer is: how much
// of the image can show through before the WORST patch of it defeats the text?
//
// Industry materials answer it the same way. Windows Acrylic/Mica normalise the
// backdrop's luminosity toward the theme before tinting; Apple's materials own
// legibility rather than trusting the wallpaper. Here that normalisation is a
// single number — the maximum image weight — solved per wallpaper × theme and
// used to cap the layer's opacity in CSS (`--wp-max-weight`, globals.css).
//
// Model, and why each choice:
//  - Extremes, not the mean. A mean grey says nothing about the black and white
//    patches a text column crosses. `analyzeWallpaperPixels` reports the 3rd /
//    97th percentile samples of WCAG luminance.
//  - Composite in gamma-encoded sRGB. That is what a browser does with
//    `opacity`; only the contrast measurement linearises (WCAG luminance).
//  - Blur credit only beyond the raster's own averaging. Each of the 48 sample
//    columns already averages ~30 CSS px of a desktop-wide image, so a blur
//    below that has nothing left to smooth. Surface backdrop blur earns no
//    credit at all: several surfaces paint without it, and Android WebViews
//    paint many blurred overlays unblurred while reporting support.
//  - Targets capped by the theme itself. A theme whose muted text is 2.9:1 on
//    its own background cannot be held to 3:1 over a wallpaper; demanding it
//    would pin every image to weight 0.

import { converter, parse } from "culori"
import { rgbRelativeLuminance } from "./contrast"
import type { BackgroundSettings } from "@/types/appearance"
import type { WallpaperThemeAnalysis } from "./wallpaper-theme-generator"

const toRgb = converter("rgb")

/**
 * The custom property the guard writes on `<body>`. globals.css reads it as
 * `opacity: min(var(--app-bg-opacity), var(--wp-max-weight, 1))` on every
 * wallpaper layer, so the cap follows fades, crossfades and live slider
 * previews without the guard re-solving for any of them.
 */
export const WP_MAX_WEIGHT_VAR = "--wp-max-weight"

/**
 * Whether the guard is on. A missing flag means ON: rows written before the
 * guard existed get the protection too — see `BackgroundSettings.legibilityGuard`.
 */
export function isLegibilityGuardOn(
  background: Pick<BackgroundSettings, "legibilityGuard">
): boolean {
  return background.legibilityGuard !== false
}

/** WCAG AA for body text. */
export const FOREGROUND_TARGET = 4.5
/**
 * Muted copy (hints, timestamps, secondary labels). WCAG's 3:1 is the floor
 * for large text and UI affordances; muted copy is the app's quietest text and
 * already sits near 4.5:1 on a bare theme, so holding it at 3:1 over an image
 * keeps it legible without flattening every wallpaper to the theme colour.
 */
export const MUTED_TARGET = 3
/** Fraction of the theme's own ratio a target may demand. See the module note. */
const NATIVE_HEADROOM = 0.95
/** Resolution of the weight scan — also what the slider can express. */
const WEIGHT_STEP = 0.01
/**
 * CSS px a raster sample already averages. The analysis draws a 48-px-wide
 * copy of the image; across a ~1440 px window that is ~30 px per sample.
 */
const RASTER_SAMPLE_PX = 30

/**
 * A translucent panel that sits over the wallpaper and carries text of its own
 * — a card, the sidebar. Its fill is `color` at `alpha`, composited over the
 * already-capped wallpaper, so it is solved stacked, not in isolation.
 */
export interface LegibilitySurface {
  color: string
  /** 0..1 — the tier's `--surface-tonality-*` percentage over a wallpaper. */
  alpha: number
}

/** The document colours the answer depends on. */
export interface LegibilityInk {
  foreground: string
  mutedForeground: string
  background: string
  /**
   * Translucent surfaces text also sits on. A theme whose card differs from
   * its background (every dark theme: the card is lighter) loses a little
   * contrast on the card that the page ground does not, and the cap has to
   * hold there too. Omitted means "page ground only".
   */
  surfaces?: LegibilitySurface[]
}

/** The patches of the wallpaper the text has to survive. */
export interface WallpaperExtremes {
  dark: string
  bright: string
  mean: string
}

/**
 * No analysis — decoding failed, or the source cannot be sampled. Assume the
 * busiest possible field; the guard would rather dim an image it knows nothing
 * about than leave text unreadable on it.
 */
export const BLIND_EXTREMES: WallpaperExtremes = {
  dark: "#000000",
  bright: "#ffffff",
  mean: "#808080",
}

export function extremesOf(analysis: WallpaperThemeAnalysis | null | undefined): WallpaperExtremes {
  if (!analysis) return BLIND_EXTREMES
  return { dark: analysis.darkExtreme, bright: analysis.brightExtreme, mean: analysis.dominant }
}

/**
 * How far the extremes survive a wallpaper blur of `blurPx`, as a factor on
 * their distance from the mean. 1 up to the raster's own averaging; beyond it
 * a Gaussian of radius σ averages roughly 2σ px, so the extremes shrink by the
 * ratio of the two windows.
 */
export function blurShrink(blurPx: number): number {
  if (!Number.isFinite(blurPx) || blurPx * 2 <= RASTER_SAMPLE_PX) return 1
  return RASTER_SAMPLE_PX / (blurPx * 2)
}

interface Rgba {
  r: number
  g: number
  b: number
  alpha: number
}

function rgbaOf(color: string): Rgba | null {
  const rgb = toRgb(parse(color))
  if (!rgb) return null
  return { r: rgb.r, g: rgb.g, b: rgb.b, alpha: rgb.alpha ?? 1 }
}

function mix(top: Rgba, bottom: Rgba, weight: number): Rgba {
  return {
    r: top.r * weight + bottom.r * (1 - weight),
    g: top.g * weight + bottom.g * (1 - weight),
    b: top.b * weight + bottom.b * (1 - weight),
    alpha: 1,
  }
}

function luminance(c: Rgba): number {
  return rgbRelativeLuminance(clamp01(c.r), clamp01(c.g), clamp01(c.b))
}

/** Contrast of text over an opaque backdrop. Translucent text is flattened onto it first. */
function textContrast(text: Rgba, backdrop: Rgba): number {
  const ink = text.alpha < 1 ? mix(text, backdrop, text.alpha) : text
  const a = luminance(ink)
  const b = luminance(backdrop)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/** One place text sits: the page ground, or a translucent surface over it. */
interface Ground {
  /** The surface fill; null for the page ground itself. */
  fill: Rgba | null
  alpha: number
  fgTarget: number
  mutedTarget: number
}

interface Prepared {
  foreground: Rgba
  muted: Rgba
  background: Rgba
  /** Extremes already pulled toward the mean by the blur credit. */
  patches: Rgba[]
  grounds: Ground[]
}

/** Targets on an opaque fill, capped by what the bare theme achieves there. */
function targetsOn(fill: Rgba, foreground: Rgba, muted: Rgba) {
  return {
    fgTarget: Math.min(FOREGROUND_TARGET, textContrast(foreground, fill) * NATIVE_HEADROOM),
    mutedTarget: Math.min(MUTED_TARGET, textContrast(muted, fill) * NATIVE_HEADROOM),
  }
}

function prepare(args: {
  ink: LegibilityInk
  extremes: WallpaperExtremes
  blurPx: number
}): Prepared | null {
  const foreground = rgbaOf(args.ink.foreground)
  const muted = rgbaOf(args.ink.mutedForeground)
  const background = rgbaOf(args.ink.background)
  const dark = rgbaOf(args.extremes.dark)
  const bright = rgbaOf(args.extremes.bright)
  const mean = rgbaOf(args.extremes.mean)
  if (!foreground || !muted || !background || !dark || !bright || !mean) return null
  // The theme background is what the wallpaper composites over; a translucent
  // one would itself sit on the page, which is opaque by the time it reaches
  // the text, so it is treated as opaque here.
  const ground: Rgba = { ...background, alpha: 1 }
  const k = blurShrink(args.blurPx)
  const shrink = (x: Rgba): Rgba => mix(x, mean, k)
  const grounds: Ground[] = [{ fill: null, alpha: 0, ...targetsOn(ground, foreground, muted) }]
  for (const surface of args.ink.surfaces ?? []) {
    const fill = rgbaOf(surface.color)
    // An unreadable surface colour or a nonsense alpha drops that surface, not
    // the whole solve: the page ground is still worth guarding.
    if (!fill || !Number.isFinite(surface.alpha)) continue
    const opaque: Rgba = { ...fill, alpha: 1 }
    // A surface's own colour alpha stacks with its tonality.
    const alpha = clamp01(surface.alpha * fill.alpha)
    if (alpha <= 0) continue
    // The theme's own look for this surface is the surface over the bare page
    // ground (image weight 0), not its colour as if opaque — measuring against
    // the opaque colour would fail a translucent card before any image shows.
    grounds.push({
      fill: opaque,
      alpha,
      ...targetsOn(mix(opaque, ground, alpha), foreground, muted),
    })
  }
  return {
    foreground,
    muted,
    background: ground,
    patches: [shrink(dark), shrink(bright)],
    grounds,
  }
}

interface Worst {
  /** Lowest foreground contrast across every ground and patch. */
  foreground: number
  /** True when some ground misses one of its own targets. */
  fails: boolean
}

/** Worst contrast over the wallpaper at one image weight, on every ground. */
function worstAt(p: Prepared, weight: number): Worst {
  let foreground = Infinity
  let fails = false
  for (const patch of p.patches) {
    const backdrop = mix(patch, p.background, weight)
    for (const g of p.grounds) {
      const under = g.fill ? mix(g.fill, backdrop, g.alpha) : backdrop
      const fg = textContrast(p.foreground, under)
      foreground = Math.min(foreground, fg)
      if (fg < g.fgTarget || textContrast(p.muted, under) < g.mutedTarget) fails = true
    }
  }
  return { foreground, fails }
}

export interface LegibilityArgs {
  ink: LegibilityInk
  extremes: WallpaperExtremes
  /** The wallpaper layer's own `filter: blur()`, in px. */
  blurPx: number
}

/**
 * Largest image weight (0..1, the effective `opacity` of the wallpaper layer)
 * at which both foreground and muted text keep their targets over both
 * extremes. Scans upward and stops at the first failure, so the answer holds
 * for every weight below it — no monotonicity is assumed (a backdrop can pass
 * *through* the text's own luminance on its way to an extreme).
 *
 * Returns 1 when any input colour is unparsable: guarding on garbage would dim
 * a wallpaper for a reason nobody can see.
 */
export function solveMaxImageWeight(args: LegibilityArgs): number {
  const p = prepare(args)
  if (!p) return 1
  let best = 0
  for (let i = 1; i * WEIGHT_STEP <= 1 + 1e-9; i++) {
    const weight = Math.min(1, i * WEIGHT_STEP)
    if (worstAt(p, weight).fails) break
    best = weight
  }
  return round2(best)
}

/**
 * Worst foreground contrast a reader meets at `weight`. What the readability
 * chip reports: the same model the guard solves against, so the chip can never
 * say FAIL at an opacity the guard considers safe, or the reverse.
 */
export function worstForegroundContrast(args: LegibilityArgs & { weight: number }): number {
  const p = prepare(args)
  if (!p) return 21
  return worstAt(p, clamp01(args.weight)).foreground
}

/**
 * The default theme's neutral palettes (globals.css `:root` / `.dark`). Theme
 * fit is judged against these rather than the live tokens because only the
 * ACTIVE variant's colours can be read off the page; the inactive one is not
 * rendered anywhere. Custom themes keep this lightness structure (their
 * foreground contrast is enforced by `ensureForegroundContrast`), so the
 * neutral pair ranks light against dark the same way.
 */
export const NEUTRAL_LIGHT_INK: LegibilityInk = {
  foreground: "#0a0a0a",
  mutedForeground: "#737373",
  background: "#ffffff",
}
export const NEUTRAL_DARK_INK: LegibilityInk = {
  foreground: "#fafafa",
  mutedForeground: "#a1a1a1",
  background: "#0a0a0a",
}

/**
 * WCAG luminance at which black and white text reach the same contrast
 * (√(1.05·0.05) − 0.05). Above it a field is "light" to a reader.
 */
const EQUAL_CONTRAST_LUMINANCE = 0.179

export type ThemeVariant = "light" | "dark"

export interface ThemeFit {
  /** The variant that lets more of this wallpaper show with text legible. */
  recommended: ThemeVariant
  /** Max image weight under each neutral variant, from {@link solveMaxImageWeight}. */
  weights: Record<ThemeVariant, number>
}

/**
 * Which variant suits a wallpaper: the one under which the guard can let more
 * of the image through. Judged by legibility, not by a brightness threshold,
 * so a mid-grey field with a few black patches is not called "light" just
 * because its average is. A tie (both show the image in full, or neither can)
 * falls back to the field's mean against the equal-contrast luminance.
 */
export function recommendThemeVariant(args: {
  extremes: WallpaperExtremes
  blurPx: number
}): ThemeFit {
  const light = solveMaxImageWeight({ ink: NEUTRAL_LIGHT_INK, ...args })
  const dark = solveMaxImageWeight({ ink: NEUTRAL_DARK_INK, ...args })
  let recommended: ThemeVariant
  if (light !== dark) recommended = light > dark ? "light" : "dark"
  else {
    const mean = rgbaOf(args.extremes.mean)
    recommended = mean && luminance(mean) > EQUAL_CONTRAST_LUMINANCE ? "light" : "dark"
  }
  return { recommended, weights: { light, dark } }
}

/**
 * How much more of the image the other variant must show before switching is
 * worth suggesting. Below this the two look alike and a prompt would be noise.
 */
export const THEME_MISMATCH_GAIN = 0.2

/**
 * The recommended variant when it differs from `current` by a margin worth
 * acting on, else null. Drives the wallpaper panel's "better in dark" hint.
 */
export function themeMismatch(fit: ThemeFit, current: ThemeVariant): ThemeVariant | null {
  if (fit.recommended === current) return null
  return fit.weights[fit.recommended] - fit.weights[current] >= THEME_MISMATCH_GAIN
    ? fit.recommended
    : null
}

/**
 * Serialise a weight for `--wp-max-weight`. A malformed custom property makes
 * the `min()` that reads it invalid at computed-value time, and `opacity` then
 * falls back to its initial value of 1 — the guard would silently switch
 * itself off. So anything non-finite is refused rather than written.
 */
export function formatMaxWeight(weight: number): string | null {
  if (!Number.isFinite(weight)) return null
  return String(Math.round(clamp01(weight) * 1000) / 1000)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
