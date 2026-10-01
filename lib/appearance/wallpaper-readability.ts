// Readability verdict for the wallpaper settings panel.
//
// The chip, the "Auto-fix" button and the runtime legibility guard all answer
// the same question — how legible is theme text over this wallpaper at this
// opacity — so they share one model: `wallpaper-legibility.ts`. The chip used
// to run a separate linear blend over the image's *mean* colour, which rated a
// black-and-white photo by the grey that appears nowhere in it, and could say
// OK at an opacity where the guard (or a reader) found text unreadable.

import { isColorParsable } from "./contrast"
import { AA_NORMAL_TEXT } from "./ensure-contrast"
import {
  extremesOf,
  solveMaxImageWeight,
  worstForegroundContrast,
  type LegibilityInk,
  type LegibilitySurface,
} from "./wallpaper-legibility"
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

export type WallpaperKind = "image" | "gradient" | "color"

export function bandRatio(ratio: number): ReadabilityBand {
  if (ratio >= AA_NORMAL_TEXT) return "ok"
  if (ratio >= AA_LARGE_TEXT) return "warn"
  return "fail"
}

/** Token → the custom property it is read from. */
const INK_VARS: Record<Exclude<keyof LegibilityInk, "surfaces">, string> = {
  foreground: "--foreground",
  mutedForeground: "--muted-foreground",
  background: "--background",
}

/**
 * The translucent surfaces text sits on over a wallpaper, and the tonality
 * token each is painted at (globals.css "Wallpaper-aware UI surfaces"): cards
 * at the translucent tier, the sidebar at glass. The tokens already carry the
 * dark bump, the no-blur fallback and reduced transparency (→ 100%, where the
 * surface is solid and cannot bind).
 */
const SURFACE_VARS: ReadonlyArray<{ color: string; tonality: string }> = [
  { color: "--card", tonality: "--surface-tonality-translucent" },
  { color: "--sidebar", tonality: "--surface-tonality-glass" },
]

/**
 * Parsable and not fully transparent. A transparent token is not a theme
 * colour anyone reads text in; solving against it would report every
 * wallpaper as legible and lift the cap.
 */
function isVisibleColor(value: string): boolean {
  if (!isColorParsable(value)) return false
  const alpha =
    /\/\s*([\d.]+)(%?)\s*\)\s*$/.exec(value) ?? /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(value)
  if (!alpha) return value.trim() !== "transparent"
  const n = Number(alpha[1]) / (alpha[2] === "%" ? 100 : 1)
  return n > 0.05
}

/** `"70%"` → 0.7; anything else → null. */
function parsePercent(value: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)%$/.exec(value.trim())
  if (!match) return null
  const n = Number(match[1]) / 100
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null
}

/**
 * Resolve the theme's text and ground colours as the page actually paints them.
 *
 * `getPropertyValue("--x")` returns the declared token text, which for a derived
 * token is an unresolved `color-mix(...)` or `var(...)` chain culori cannot
 * parse. Painting the token onto a probe's `color` makes the engine resolve it;
 * the raw declaration is only the fallback for environments that do not
 * substitute custom properties (jsdom). Null outside the browser, or when a
 * colour is unreadable either way — a guess here would dim a wallpaper, or
 * clear it, for a reason nobody can see.
 */
export function readThemeInk(): LegibilityInk | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null
  const host = document.body ?? document.documentElement
  const probe = document.createElement("span")
  probe.setAttribute("aria-hidden", "true")
  probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden"
  host.appendChild(probe)
  const root = getComputedStyle(document.documentElement)
  try {
    // `!important` inline: a page-wide `* { color: … !important }` — user
    // custom CSS, or a screenshot harness hiding text — would otherwise repaint
    // the probe, and the guard would read the theme's text as that colour.
    // An inline important declaration outranks any stylesheet one.
    const read = (property: string): string | null => {
      probe.style.setProperty("color", `var(${property})`, "important")
      const painted = getComputedStyle(probe).color.trim()
      if (painted && isVisibleColor(painted)) return painted
      const declared = root.getPropertyValue(property).trim()
      return declared && isVisibleColor(declared) ? declared : null
    }
    const foreground = read(INK_VARS.foreground)
    const mutedForeground = read(INK_VARS.mutedForeground)
    const background = read(INK_VARS.background)
    if (!foreground || !mutedForeground || !background) return null
    // A surface whose colour or tonality cannot be read is left out rather
    // than failing the read: the page ground is still worth guarding.
    const surfaces: LegibilitySurface[] = []
    for (const { color, tonality } of SURFACE_VARS) {
      const fill = read(color)
      const alpha = parsePercent(root.getPropertyValue(tonality))
      if (fill && alpha !== null) surfaces.push({ color: fill, alpha })
    }
    return { foreground, mutedForeground, background, surfaces }
  } finally {
    probe.remove()
  }
}

export interface OpacityVerdictArgs {
  kind: WallpaperKind | null
  opacity: number
  /** The wallpaper layer's blur; heavy blur earns legibility credit. */
  blurPx?: number
  analysis?: WallpaperThemeAnalysis | null
  /** Whether the legibility guard is on — it caps the opacity actually painted. */
  guard?: boolean
  /** Injected for tests; defaults to {@link readThemeInk}. */
  ink?: LegibilityInk | null
}

export interface OpacityVerdict extends ReadabilityVerdict {
  /** Opacity the auto-fix button would apply; null when already `ok` or guarded. */
  suggestedOpacity: number | null
  /** True when the estimate used real sampled pixels rather than the blind floor. */
  measured: boolean
  /** Highest image weight that keeps theme text legible over this wallpaper. */
  maxWeight: number
  /** The opacity the layer really paints at: capped by the guard when on. */
  effectiveOpacity: number
  /** True when the guard is on AND is currently holding the opacity down. */
  capped: boolean
}

/**
 * Live readability verdict for the wallpaper panel. `ratio` is the worst
 * foreground contrast a reader meets at the opacity actually painted — with the
 * guard on that is the capped opacity, so the chip reports what is on screen
 * rather than what the slider says. Returns null on SSR, when no wallpaper is
 * active, or when the theme colours cannot be read.
 */
export function computeOpacityVerdict(args: OpacityVerdictArgs): OpacityVerdict | null {
  const { kind, opacity, analysis } = args
  if (kind === null) return null
  const ink = args.ink === undefined ? readThemeInk() : args.ink
  if (!ink) return null
  const blurPx = args.blurPx ?? 0
  const extremes = extremesOf(analysis)
  const maxWeight = solveMaxImageWeight({ ink, extremes, blurPx })
  const requested = Math.max(0, Math.min(1, opacity))
  const capped = Boolean(args.guard) && requested > maxWeight
  const effectiveOpacity = capped ? maxWeight : requested
  const ratio = worstForegroundContrast({ ink, extremes, blurPx, weight: effectiveOpacity })
  const level = bandRatio(ratio)
  return {
    level,
    ratio,
    // With the guard on there is nothing to fix by hand — it already holds the
    // layer at `maxWeight`. Off, suggest it, but only when it is actually lower:
    // a theme whose own contrast misses AA cannot be rescued by the slider.
    suggestedOpacity: !args.guard && level !== "ok" && maxWeight < requested ? maxWeight : null,
    measured: Boolean(analysis),
    maxWeight,
    effectiveOpacity,
    capped,
  }
}
