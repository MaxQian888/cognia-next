// Turning cursor art into something the `cursor:` property will actually paint.
//
// Two problems this module owns:
//
//  1. **Palette resolution.** A pack ships its own four colors, but the user can
//     ask for the cursor to follow the live theme accent (or a color they
//     picked). Re-tinting cannot just swap the fill: the outline is what keeps a
//     24px glyph visible on a same-colored surface, so it has to be re-derived
//     against the new fill, and the interactive accent has to stay separable
//     from the fill it sits on.
//
//  2. **Raster fallback.** Chromium paints SVG cursors; WebKit (which is what
//     the Tauri shell runs on macOS, and what iOS Capacitor runs everywhere)
//     historically does not, and silently falls back to the keyword. So the art
//     is rasterized to a PNG data URL through a canvas before being handed to
//     CSS, with the SVG data URL kept as the synchronous first paint and as the
//     fallback when no canvas is available (SSR, jsdom, a locked-down CSP).
//
// Both raster and SVG results are memoised — the applier re-runs on every theme
// change, and re-encoding eight glyphs each time would be pure waste.

import { converter, formatHex, parse } from "culori"
import { wcagContrast } from "@/lib/appearance/contrast"
import type { CursorPack, CursorPalette, CursorRole } from "@/types/appearance"
import { CURSOR_SIZE_MAX, CURSOR_SIZE_MIN } from "@/types/appearance"
import { buildCursorSvg, CURSOR_SHAPE_DEFS, scaledHotspot, type CursorShapeDef } from "./cursor-art"

const toOklch = converter("oklch")

/** Authoring size in CSS px at scale 1. */
export const CURSOR_BASE_PX = 24

/**
 * Browsers ignore cursor images larger than 128×128 and silently fall back to
 * the keyword — the cursor would just *stop being themed* at the top of the
 * size slider, with nothing to explain it.
 *
 * This is not clamped at runtime, because it cannot be reached: the size range
 * (`CURSOR_SIZE_MIN`..`CURSOR_SIZE_MAX`) is chosen so that the largest cursor
 * lands well inside it, and `cursorPixelSize` clamps the *scale*. The constant
 * exists so that relationship is checkable — `render-cursor.test.ts` asserts
 * the range still fits, which is what catches a future "let users go to 8×".
 */
export const CURSOR_MAX_PX = 128

/**
 * Rendered edge in CSS px for a user size multiplier. The scale is clamped (it
 * arrives from persisted settings, where a hand-edited or corrupt row could
 * carry anything) and the pixel size follows from it.
 */
export function cursorPixelSize(scale: number | undefined): number {
  const safe = Number.isFinite(scale)
    ? Math.min(Math.max(scale as number, CURSOR_SIZE_MIN), CURSOR_SIZE_MAX)
    : 1
  return Math.round(CURSOR_BASE_PX * safe)
}

/** Shift a color's OKLCH lightness, clamped to the usable range. */
function shiftLightness(color: string, delta: number): string {
  const c = toOklch(parse(color))
  if (!c) return color
  const l = Math.min(Math.max((c.l ?? 0.5) + delta, 0.05), 0.98)
  return formatHex({ ...c, l, mode: "oklch" }) ?? color
}

/**
 * Pick the outline that keeps `fill` legible. Whichever of near-white /
 * near-black contrasts more wins — a mid-tone fill is the hard case, and the
 * winner there is what a designer would reach for anyway.
 */
export function deriveOutline(fill: string): string {
  const light = "#ffffff"
  const dark = "#12121a"
  return wcagContrast(light, fill) >= wcagContrast(dark, fill) ? light : dark
}

export interface ResolvePaletteInput {
  pack: CursorPack
  colorMode: "pack" | "accent" | "custom"
  /** Used when `colorMode` is `"custom"`. */
  customColor?: string
  /** The live theme accent (`--primary`), used when `colorMode` is `"accent"`. */
  accentColor?: string
}

/**
 * Resolve the palette the art is painted with.
 *
 * Re-tinted modes keep the pack's *structure* (does it glow? does it read as
 * light-on-dark?) while replacing its hue, so "Sakura tinted with my accent"
 * still looks like Sakura. A tint request with no usable color falls back to
 * the pack palette rather than rendering an invisible cursor.
 */
export function resolveCursorPalette({
  pack,
  colorMode,
  customColor,
  accentColor,
}: ResolvePaletteInput): CursorPalette {
  if (colorMode === "pack") return pack.palette
  const raw = colorMode === "custom" ? customColor : accentColor
  const base = raw && parse(raw) ? formatHex(parse(raw)!) : null
  if (!base) return pack.palette

  const stroke = deriveOutline(base)
  // The interactive accent must separate from the fill it sits on. Push it away
  // from the fill in the same direction the outline went, so the badge reads on
  // both a pale and a deep tint.
  const towardLight = stroke === "#ffffff"
  return {
    fill: base,
    stroke,
    accent: shiftLightness(base, towardLight ? 0.22 : -0.22),
    glow: pack.palette.glow ? base : undefined,
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * `data:image/svg+xml,` with percent-encoding rather than base64: it is ~30%
 * smaller for this kind of markup and stays readable in devtools. Only the
 * characters that break out of a CSS `url("…")` are encoded.
 */
export function svgToDataUrl(svg: string): string {
  const encoded = svg
    .replace(/\s{2,}/g, " ")
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/"/g, "'")
  return `data:image/svg+xml,${encoded}`
}

/** Build the CSS value for one cursor: `url("…") hx hy, <keyword>`. */
export function cursorCssValue(
  imageUrl: string,
  hotspot: { x: number; y: number },
  fallbackKeyword: string
): string {
  return `url("${imageUrl}") ${hotspot.x} ${hotspot.y}, ${fallbackKeyword}`
}

const rasterCache = new Map<string, string>()

/** Test seam — the applier's caches must not leak between suites. */
export function clearCursorRasterCache(): void {
  rasterCache.clear()
}

/**
 * Rasterize an SVG string to a PNG data URL at `sizePx`, for the engines that
 * refuse SVG cursors. Resolves `null` (never rejects) when no canvas pipeline
 * is available or the decode fails — callers keep using the SVG URL, which is
 * correct on the engines that do support it.
 */
export async function rasterizeCursorSvg(svg: string, sizePx: number): Promise<string | null> {
  const key = `${sizePx}:${svg}`
  const cached = rasterCache.get(key)
  if (cached) return cached
  if (typeof document === "undefined" || typeof Image === "undefined") return null

  try {
    const canvas = document.createElement("canvas")
    // Render at 2× and let CSS scale down: a cursor is composited by the OS at
    // the device scale, and a 1× raster visibly softens on a HiDPI display.
    const scale = 2
    canvas.width = sizePx * scale
    canvas.height = sizePx * scale
    const ctx = canvas.getContext?.("2d")
    if (!ctx) return null

    const url = svgToDataUrl(svg)
    const loaded = await new Promise<boolean>((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          resolve(true)
        } catch {
          resolve(false)
        }
      }
      img.onerror = () => resolve(false)
      img.src = url
    })
    if (!loaded) return null

    const png = canvas.toDataURL("image/png")
    if (!png || !png.startsWith("data:image/png")) return null
    rasterCache.set(key, png)
    return png
  } catch {
    return null
  }
}

export interface RenderedRole {
  role: CursorRole
  /** SVG markup, before encoding — kept so the settings preview can inline it. */
  svg: string
  hotspot: { x: number; y: number }
  /** The CSS value using the (always-available) SVG data URL. */
  svgCss: string
}

/** Look up the shape definition backing a pack. */
export function shapeForPack(pack: CursorPack): CursorShapeDef {
  return CURSOR_SHAPE_DEFS[pack.shape]
}

/**
 * Render every role a pack declares. Synchronous — the raster upgrade is a
 * separate, optional pass so the first paint never waits on a canvas decode.
 */
export function renderPackRoles(
  pack: CursorPack,
  palette: CursorPalette,
  sizePx: number,
  roleKeyword: Record<CursorRole, string>
): RenderedRole[] {
  const shape = shapeForPack(pack)
  return pack.roles.map((role) => {
    const svg = buildCursorSvg({ role, shape, palette, sizePx })
    const hotspot = scaledHotspot(role, shape, sizePx)
    return {
      role,
      svg,
      hotspot,
      svgCss: cursorCssValue(svgToDataUrl(svg), hotspot, roleKeyword[role]),
    }
  })
}
