// Theme wallpaper layer: pairs each immersive share theme with a real, inlined
// wallpaper photo (a `data:image/*;base64,` URL from `wallpapers.generated.ts`)
// and produces the CSS that lays it behind the exported chat HTML / usage card /
// quote card with a legibility scrim.
//
// Two load-bearing constraints shape this module:
//   1. Exported HTML renders in a `srcDoc` sandboxed iframe (about:srcdoc origin)
//      and on the public Cloudflare Pages viewer — relative asset URLs never
//      resolve there, so the wallpaper MUST be an inlined data URL.
//   2. The generated data-URL map is ~hundreds of KB. It is kept out of every
//      broadly-imported module and only `import()`ed on demand by
//      `resolveThemeWallpaper` when the user actually enables a wallpaper, so it
//      lands in a lazy chunk and never touches app startup.

import type { ThemeId, ThemeTokens } from "./syntax-themes"

/**
 * Themes that ship a curated wallpaper. The immersive/flagship themes get a
 * photo backdrop; the plain "document" themes (light/github/sepia/…) stay flat
 * by design. Kept as a tiny static list (no image data) so `themeHasWallpaper`
 * is cheap and synchronous everywhere it is called.
 */
export const WALLPAPER_THEME_IDS = [
  "arknights",
  "cyberpunk",
  "terminal",
  "sakura",
  "catppuccin-mocha",
  "aurora",
  "genshin",
  "honkai",
] as const

export type WallpaperThemeId = (typeof WALLPAPER_THEME_IDS)[number]

const WALLPAPER_ID_SET: ReadonlySet<string> = new Set(WALLPAPER_THEME_IDS)

/** Whether a theme has a curated wallpaper available. */
export function themeHasWallpaper(theme: ThemeId | undefined): boolean {
  return theme != null && WALLPAPER_ID_SET.has(theme)
}

/**
 * Resolve a theme's inlined wallpaper data URL when `enabled`, else `undefined`.
 * Lazily imports the heavy generated map so it only loads when a wallpaper is
 * actually requested. Returns `undefined` (graceful no-op) for disabled toggles,
 * themes without a wallpaper, or a wallpaper that failed to regenerate.
 */
export async function resolveThemeWallpaper(
  theme: ThemeId | undefined,
  enabled: boolean
): Promise<string | undefined> {
  if (!enabled || !themeHasWallpaper(theme)) return undefined
  try {
    const { THEME_WALLPAPERS } = await import("./wallpapers.generated")
    return THEME_WALLPAPERS[theme as ThemeId]
  } catch {
    // Missing/broken generated module ⇒ render no backdrop rather than throw.
    return undefined
  }
}

/** Scrim alpha laid over the photo so body text stays legible. */
const SCRIM_ALPHA = 0.78

/**
 * Full-page backdrop for the beautiful/animated chat export. Appended AFTER the
 * base stylesheet and the style preset so it wins: the photo lives on `html`,
 * `body` goes transparent (so a preset's `body{background-image:<grid>}` layers
 * on top of the photo instead of hiding it). A scrim over the photo keeps the
 * accent heading + muted footer readable; message bubbles keep their opaque
 * backgrounds so body text never sits on the raw image.
 */
export function buildWallpaperBackdropCss(dataUrl: string, t: ThemeTokens): string {
  const scrim = rgbaFromHex(t.bg, SCRIM_ALPHA)
  return `
html { min-height: 100%; background-color: ${t.bg}; background-image: linear-gradient(${scrim}, ${scrim}), url("${dataUrl}"); background-size: cover; background-position: center; background-attachment: fixed; background-repeat: no-repeat; }
body { background-color: transparent; }
@media (max-width: 600px) { html { background-attachment: scroll; } }
`
}

/**
 * Card backdrop for the usage card / quote card. Uses the card element's own
 * `background-image` (superseding any preset grid) rather than a `::before`
 * layer — html2canvas 1.4.1 rasterizes element backgrounds reliably but is
 * flaky with pseudo-element background images. Opaque tiles/bubbles keep the
 * numbers and quoted text readable over the scrimmed photo.
 */
export function buildCardWallpaperCss(dataUrl: string, t: ThemeTokens): string {
  const scrim = rgbaFromHex(t.bg, SCRIM_ALPHA)
  return `
.ucard, .qcard { background-image: linear-gradient(${scrim}, ${scrim}), url("${dataUrl}"); background-size: cover; background-position: center; background-repeat: no-repeat; }
`
}

/** `#rrggbb` (or 3-digit) hex → `rgba(r,g,b,alpha)`; opaque-safe grey fallback. */
export function rgbaFromHex(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)
  if (!m) return `rgba(128,128,128,${alpha})`
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`
}
