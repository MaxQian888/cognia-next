"use client"

import { converter, formatHex, parse } from "culori"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin"
import type { WallpaperPosition, WallpaperSource } from "@/types/appearance"
import { ensureForegroundContrast } from "./ensure-contrast"
import { DEFAULT_FALLBACKS } from "./vscode-theme/token-mapping"
import { disposeUrl, resolveSourceToCss } from "./wallpaper-storage"

const SAMPLE_WIDTH = 48
const MIN_SAMPLE_HEIGHT = 12
const MAX_SAMPLE_HEIGHT = 96
const VISIBLE_ALPHA = 96
const LIGHT_VARIANT_THRESHOLD = 0.58
/** Minimum hue separation (degrees) before a bin counts as a second family. */
const SECONDARY_HUE_SEPARATION = 40
/** Hue histogram resolution — 24 bins of 15°, fine enough to split adjacent families. */
const HUE_BINS = 24
const HUE_BIN_SIZE = 360 / HUE_BINS
/**
 * Mean per-pixel accent weight below which the image is treated as having no
 * usable hue at all (a grayscale photo, a flat neutral fill) and the plain
 * average becomes the honest answer. Deliberately a *mean*, not a total: the
 * same analyzer runs over a 48×N raster and over the handful of colour stops
 * synthesized from a CSS gradient, and an absolute floor would reject the
 * latter outright.
 */
const MIN_MEAN_ACCENT_WEIGHT = 0.01
/** Hue rotation used to synthesize a secondary when the image has only one. */
const SECONDARY_FALLBACK_ROTATION = 150
/**
 * Lightness band (oklch L) an extracted colour is pulled into before it is used
 * as a UI accent. A wallpaper's dominant hue family is often near-black
 * (`Mahou`, `Slate`) or near-white (`Cream`); either makes an unusable primary
 * button, so the hue is kept and only the lightness is moved.
 */
const ACCENT_MIN_LIGHTNESS = 0.45
const ACCENT_MAX_LIGHTNESS = 0.78

const toOklch = converter("oklch")
const toRgb = converter("rgb")

export interface WallpaperThemeAnalysis {
  /** Most saturated, mid-luminance color — drives primary / ring / accents. */
  accent: string
  /**
   * Second color family, at least {@link SECONDARY_HUE_SEPARATION}° away from
   * the accent. Synthesized by hue rotation for single-hue wallpapers so
   * consumers never have to special-case it.
   */
  secondary: string
  /** Plain average color — what actually sits behind body text. */
  dominant: string
  averageLuminance: number
  /**
   * Population standard deviation of per-pixel luminance, 0..1. A flat fill is
   * 0; a high-contrast photo approaches 0.5. Drives both the readability
   * estimate and the recommended opacity/blur.
   */
  luminanceSpread: number
  baseVariant: "light" | "dark"
}

/**
 * Analyze a small RGBA raster and extract the image-derived decisions Cognia
 * needs for theme generation: an accent, a contrasting secondary, the mean
 * color behind text, and how busy the field is. The saturation/luminance
 * weighting is adapted from the MIT-licensed Codex Dream Skin renderer, but
 * kept independent of DOM and persistence so callers and tests cross one small
 * seam.
 */
export function analyzeWallpaperPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number
): WallpaperThemeAnalysis {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("wallpaper dimensions are invalid")
  }
  if (data.length < width * height * 4) {
    throw new Error("wallpaper pixel buffer is incomplete")
  }

  let count = 0
  let totalRed = 0
  let totalGreen = 0
  let totalBlue = 0
  let totalLuminance = 0
  let totalLuminanceSquared = 0
  const bins: HueBin[] = Array.from({ length: HUE_BINS }, () => ({ r: 0, g: 0, b: 0, weight: 0 }))
  let totalAccentWeight = 0

  const pixelCount = width * height * 4
  for (let offset = 0; offset < pixelCount; offset += 4) {
    // The length guard above proves every index below is in bounds, so the
    // reads are asserted rather than defaulted — a `?? 0` here would be an
    // unreachable branch on the hottest loop in the module.
    if (data[offset + 3]! < VISIBLE_ALPHA) continue
    const red = data[offset]!
    const green = data[offset + 1]!
    const blue = data[offset + 2]!
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255

    totalRed += red
    totalGreen += green
    totalBlue += blue
    totalLuminance += luminance
    totalLuminanceSquared += luminance * luminance
    count += 1

    const weight = accentWeightOf(red, green, blue, luminance)
    const bin = bins[Math.min(HUE_BINS - 1, Math.floor(hueOf([red, green, blue]) / HUE_BIN_SIZE))]!
    bin.r += red * weight
    bin.g += green * weight
    bin.b += blue * weight
    bin.weight += weight
    totalAccentWeight += weight
  }

  if (count === 0) throw new Error("wallpaper contains no visible pixels")

  const averageLuminance = totalLuminance / count
  const average: [number, number, number] = [
    totalRed / count,
    totalGreen / count,
    totalBlue / count,
  ]

  // Accent = the mean of the single heaviest hue family, not the mean of every
  // saturated pixel. On a two-tone wallpaper (magenta + cyan) the global mean
  // is a purple that appears nowhere in the image; the heaviest bin is the
  // magenta the user can actually see.
  const hasUsableHue = totalAccentWeight / count >= MIN_MEAN_ACCENT_WEIGHT
  const primaryBin = hasUsableHue ? heaviestBin(bins) : null
  const accentChannels: [number, number, number] = primaryBin ? binMean(primaryBin) : average
  const accent = usableAccent(rgbToHex(accentChannels))

  // Secondary = the heaviest *other* hue family, so the two swatches stay
  // visibly distinct instead of collapsing back into their blend.
  const secondaryBin = primaryBin
    ? heaviestBin(
        bins.filter(
          (bin, index) =>
            bin !== primaryBin &&
            hueDistance(binCenterHue(index), hueOf(accentChannels)) >= SECONDARY_HUE_SEPARATION
        )
      )
    : null
  const secondary = usableAccent(secondaryBin ? rgbToHex(binMean(secondaryBin)) : rotateHue(accent))

  // Population variance, floored at 0 — floating-point cancellation can push
  // E[l²] - E[l]² a hair below zero for a perfectly uniform field.
  const variance = Math.max(0, totalLuminanceSquared / count - averageLuminance ** 2)

  return {
    accent,
    secondary,
    dominant: rgbToHex(average),
    averageLuminance,
    luminanceSpread: Math.sqrt(variance),
    baseVariant: averageLuminance >= LIGHT_VARIANT_THRESHOLD ? "light" : "dark",
  }
}

/**
 * Pull a colour into the accent lightness band, preserving hue and chroma.
 * Returns the input untouched when it is already usable, so the common case
 * hands back a colour that is literally present in the wallpaper.
 */
export function usableAccent(hex: string): string {
  const oklch = toOklch(parse(hex))
  if (!oklch) return hex
  const lightness = Math.max(ACCENT_MIN_LIGHTNESS, Math.min(ACCENT_MAX_LIGHTNESS, oklch.l))
  if (lightness === oklch.l) return hex
  return formatHex({ ...oklch, l: lightness })
}

/** One hue family's weighted colour sum. */
interface HueBin {
  r: number
  g: number
  b: number
  weight: number
}

function heaviestBin(bins: HueBin[]): HueBin | null {
  let best: HueBin | null = null
  for (const bin of bins) {
    if (bin.weight > 0 && (!best || bin.weight > best.weight)) best = bin
  }
  return best
}

function binMean(bin: HueBin): [number, number, number] {
  return [bin.r / bin.weight, bin.g / bin.weight, bin.b / bin.weight]
}

function binCenterHue(index: number): number {
  return index * HUE_BIN_SIZE + HUE_BIN_SIZE / 2
}

/**
 * Weight a pixel's contribution to the accent: strongly saturated colors in the
 * mid-luminance band win, because those are the ones a UI can safely reuse as
 * a primary. Near-black, near-white, and gray pixels contribute almost nothing.
 *
 * Both factors are squared. HSV saturation stays high as a color approaches
 * black (`#090e27` scores 0.77), so a linear luminance term let near-black
 * navies out-vote the mid-tone gold or lavender a user would actually call the
 * image's accent — and a near-black primary makes for an invisible button.
 * Squaring the luminance term is what puts the mid band in charge.
 */
function accentWeightOf(red: number, green: number, blue: number, luminance: number): number {
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const saturation = max === 0 ? 0 : (max - min) / max
  const usableLuminance = 1 - Math.min(1, Math.abs(luminance - 0.46) / 0.54)
  return saturation ** 2 * usableLuminance ** 2
}

/** Hue in degrees (0..360) straight from RGB — gray returns 0. */
function hueOf(channels: [number, number, number]): number {
  const [r, g, b] = channels
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  let hue: number
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue *= 60
  return hue < 0 ? hue + 360 : hue
}

/** Shortest angular distance between two hues, 0..180. */
function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}

function rotateHue(hex: string, degrees: number = SECONDARY_FALLBACK_ROTATION): string {
  const oklch = toOklch(parse(hex))
  if (!oklch) return hex
  return formatHex({ ...oklch, h: ((oklch.h ?? 0) + degrees) % 360 }) ?? hex
}

/**
 * Decode and downsample one persisted Cognia wallpaper locally.
 *
 * Images go through a canvas; gradients and solid colors are analyzed from
 * their declared color stops, so "generate a theme from this wallpaper" works
 * for the built-in gradient presets too — they are the majority of the gallery
 * and used to be excluded outright.
 */
export async function analyzeWallpaperSource(
  source: WallpaperSource
): Promise<WallpaperThemeAnalysis> {
  if (source.kind === "color") return analyzeCssColors([source.value])
  if (source.kind === "gradient") return analyzeCssColors(extractCssColorStops(source.css))

  const css = await resolveSourceToCss(source)
  try {
    const imageUrl = extractCssUrl(css)
    const image = await loadImage(imageUrl)
    const height = Math.max(
      MIN_SAMPLE_HEIGHT,
      Math.min(
        MAX_SAMPLE_HEIGHT,
        Math.round((SAMPLE_WIDTH * image.naturalHeight) / image.naturalWidth)
      )
    )
    const canvas = document.createElement("canvas")
    canvas.width = SAMPLE_WIDTH
    canvas.height = height
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) throw new Error("wallpaper analysis canvas is unavailable")
    context.drawImage(image, 0, 0, SAMPLE_WIDTH, height)
    return analyzeWallpaperPixels(
      context.getImageData(0, 0, SAMPLE_WIDTH, height).data,
      SAMPLE_WIDTH,
      height
    )
  } finally {
    disposeUrl(css)
  }
}

/**
 * Pull the color stops out of a CSS gradient declaration, in source order.
 *
 * Deliberately permissive: every color-shaped token is handed to culori and
 * kept only if it parses to something visible. That drops the geometry terms
 * (`135deg`, `circle`, `at`, `to bottom`) without having to model gradient
 * grammar, and drops `transparent` stops, which carry no color information.
 */
export function extractCssColorStops(css: string): string[] {
  const tokens =
    css.match(
      /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|\b[a-zA-Z]+\b/g
    ) ?? []
  const stops: string[] = []
  for (const token of tokens) {
    const parsed = parse(token)
    if (!parsed) continue
    if ((parsed.alpha ?? 1) < 0.05) continue
    stops.push(token)
  }
  return stops
}

/**
 * Analyze a list of CSS colors by rasterizing them into a synthetic, evenly
 * weighted buffer and reusing {@link analyzeWallpaperPixels}. One code path
 * means a gradient and a photo of the same palette produce comparable numbers.
 */
export function analyzeCssColors(colors: string[]): WallpaperThemeAnalysis {
  const channels: number[] = []
  for (const color of colors) {
    const rgb = toRgb(parse(color))
    if (!rgb) continue
    channels.push(
      clamp255((rgb.r ?? 0) * 255),
      clamp255((rgb.g ?? 0) * 255),
      clamp255((rgb.b ?? 0) * 255),
      255
    )
  }
  if (channels.length === 0) throw new Error("wallpaper contains no visible pixels")
  return analyzeWallpaperPixels(new Uint8ClampedArray(channels), channels.length / 4, 1)
}

/**
 * Background opacity + blur that keep a wallpaper of this character readable.
 *
 * A flat fill needs neither: its contrast is already what the chip measures.
 * A busy photo gets pushed down in opacity and up in blur, both proportional
 * to `luminanceSpread`, because blur is what turns a high-frequency field into
 * the smooth one the linear contrast model actually assumes.
 */
export function recommendBackgroundTuning(
  analysis: WallpaperThemeAnalysis,
  kind: "image" | "gradient" | "color"
): { opacity: number; blurPx: number } {
  const spread = Math.max(0, Math.min(1, analysis.luminanceSpread))
  if (kind !== "image") {
    return { opacity: round2(Math.max(0.4, 1 - spread)), blurPx: 0 }
  }
  return {
    opacity: round2(Math.max(0.25, Math.min(0.9, 0.85 - spread * 1.4))),
    blurPx: Math.max(0, Math.min(16, Math.round(spread * 28))),
  }
}

/**
 * The fit that suits a wallpaper's aspect ratio against a typical desktop
 * window. Panoramas and portrait shots both lose their subject to a `cover`
 * crop, so we surface `contain` for the extremes and leave everything within
 * a window's reach on `cover`.
 */
export function recommendPosition(width: number, height: number): WallpaperPosition {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return "cover"
  }
  const ratio = width / height
  // Roughly 21:9 and 3:4 — beyond these a cover crop discards over half the frame.
  return ratio > 2.4 || ratio < 0.75 ? "contain" : "cover"
}

/** Build a persistent dual-variant Cognia theme from a wallpaper analysis. */
export function buildWallpaperTheme(
  name: string,
  analysis: WallpaperThemeAnalysis
): Omit<CustomTheme, "id"> {
  const light = ensureForegroundContrast(deriveVariantTokens(DEFAULT_FALLBACKS.light, analysis))
  const dark = ensureForegroundContrast(deriveVariantTokens(DEFAULT_FALLBACKS.dark, analysis))
  const tokens = { light, dark }
  const colors = tokens[analysis.baseVariant]

  return {
    name,
    baseVariant: analysis.baseVariant,
    tokens,
    colors,
    isDark: analysis.baseVariant === "dark",
  }
}

/**
 * Surfaces the accent hue reaches, and how much chroma each may absorb.
 *
 * Kept deliberately small: the point is that the chrome feels like it belongs
 * with the wallpaper, not that it competes with it. Page-level surfaces get
 * the faintest wash; the muted/secondary family carries the second hue so a
 * two-tone wallpaper reads as two tones rather than one.
 */
const ACCENT_TINTED: ReadonlyArray<readonly [keyof ThemeColors, number]> = [
  ["background", 0.008],
  ["card", 0.008],
  ["popover", 0.008],
  ["border", 0.018],
  ["input", 0.018],
  ["sidebarBorder", 0.018],
]
const SECONDARY_TINTED: ReadonlyArray<readonly [keyof ThemeColors, number]> = [
  ["muted", 0.016],
  ["secondary", 0.02],
  ["sidebar", 0.01],
  ["sidebarAccent", 0.016],
]

function deriveVariantTokens(base: ThemeColors, analysis: WallpaperThemeAnalysis): ThemeColors {
  const accentHue = hueOfCss(analysis.accent)
  const secondaryHue = hueOfCss(analysis.secondary) ?? accentHue
  const next: ThemeColors = {
    ...base,
    primary: analysis.accent,
    accent: analysis.accent,
    ring: analysis.accent,
    sidebarPrimary: analysis.accent,
    sidebarRing: analysis.accent,
  }
  const tintAll = (
    entries: ReadonlyArray<readonly [keyof ThemeColors, number]>,
    hue: number
  ): void => {
    for (const [key, chroma] of entries) {
      next[key] = tintTowardHue(next[key], hue, chroma)
    }
  }
  if (accentHue !== null) tintAll(ACCENT_TINTED, accentHue)
  if (secondaryHue !== null) tintAll(SECONDARY_TINTED, secondaryHue)
  return next
}

/**
 * Rotate a token's hue onto the wallpaper's and set its chroma, preserving
 * lightness. Lightness is what carries contrast, so leaving it alone means
 * `ensureForegroundContrast` rarely has to intervene. Every tinted token is a
 * near-neutral from {@link DEFAULT_FALLBACKS}, so replacing chroma outright
 * (rather than raising it) keeps the wash even across the palette.
 */
function tintTowardHue(value: string, hue: number, chroma: number): string {
  const oklch = toOklch(parse(value))
  // Unparsable is only reachable via a hand-edited fallback table; leave the
  // token exactly as it was rather than dropping it.
  if (!oklch) return value
  return formatHex({ ...oklch, h: hue, c: chroma }) ?? value
}

function hueOfCss(value: string): number | null {
  const oklch = toOklch(parse(value))
  if (!oklch) return null
  return oklch.h ?? null
}

function clamp255(channel: number): number {
  return Math.max(0, Math.min(255, Math.round(channel)))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function rgbToHex(channels: [number, number, number]): string {
  return `#${channels.map((channel) => clamp255(channel).toString(16).padStart(2, "0")).join("")}`
}

function extractCssUrl(css: string): string {
  const match = /^url\((['"]?)(.*)\1\)$/.exec(css.trim())
  if (!match?.[2]) throw new Error("wallpaper source is not an image URL")
  return match[2]
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("wallpaper image could not be decoded"))
    image.src = url
  })
}
