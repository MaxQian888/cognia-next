// Wallpaper fit resolution: turns the user's (position, focal point) choice
// into the three CSS values the wallpaper layer actually consumes
// (`--app-bg-size` / `--app-bg-repeat` / `--app-bg-position`).
//
// Kept pure and DOM-free so `background-applier.tsx`, the gallery preview tile,
// and the settings UI all derive the same values from one place — the previous
// inline ternary chain in the applier meant the preview tile and the live
// wallpaper could disagree about what "contain" looks like.

import type { WallpaperPosition } from "@/types/appearance"

/**
 * The custom properties the wallpaper layer in `globals.css` reads off
 * `<body>`. `background-applier.tsx` owns writing them; the settings UI writes
 * the two live-preview ones directly during a slider drag so the wallpaper
 * tracks the gesture without a Dexie round-trip per pointer move.
 */
export const BG_VARS = {
  image: "--app-bg-image",
  blur: "--app-bg-blur",
  opacity: "--app-bg-opacity",
  position: "--app-bg-position",
  size: "--app-bg-size",
  repeat: "--app-bg-repeat",
} as const

/** The wallpaper fits the user can pick, in the order the UI lists them. */
export const WALLPAPER_POSITIONS: readonly WallpaperPosition[] = [
  "cover",
  "contain",
  "fill",
  "center",
  "tile",
] as const

/** Resolved CSS for one wallpaper layer. */
export interface BackgroundFit {
  /** `background-size` */
  size: string
  /** `background-repeat` */
  repeat: string
  /** `background-position` */
  position: string
}

/**
 * Fits that leave the image free to slide inside its box, so a focal point
 * changes what the user sees. `fill` stretches to the box (nothing to anchor)
 * and `tile` covers it edge to edge (an offset only shifts the seam).
 */
const FOCAL_AWARE: ReadonlySet<WallpaperPosition> = new Set<WallpaperPosition>([
  "cover",
  "contain",
  "center",
])

/** Whether a focal point is meaningful for this fit — drives UI disclosure. */
export function supportsFocalPoint(position: WallpaperPosition): boolean {
  return FOCAL_AWARE.has(position)
}

/** Clamp an untrusted focal coordinate into 0..100, defaulting to centre. */
export function clampFocal(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 50
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** One cell of the 3×3 quick-pick grid in the settings UI. */
export interface FocalPreset {
  id: string
  x: number
  y: number
}

/**
 * Nine anchors, in reading order, so the UI can render them straight into a
 * `grid-cols-3`. Ids double as i18n key suffixes.
 */
export const FOCAL_PRESETS: readonly FocalPreset[] = [
  { id: "topLeft", x: 0, y: 0 },
  { id: "top", x: 50, y: 0 },
  { id: "topRight", x: 100, y: 0 },
  { id: "left", x: 0, y: 50 },
  { id: "center", x: 50, y: 50 },
  { id: "right", x: 100, y: 50 },
  { id: "bottomLeft", x: 0, y: 100 },
  { id: "bottom", x: 50, y: 100 },
  { id: "bottomRight", x: 100, y: 100 },
] as const

/**
 * Id of the preset that exactly matches this focal point, or null when the
 * user has dragged the sliders somewhere in between (the UI then shows no
 * cell as selected rather than lying about the nearest one).
 */
export function focalPresetId(focalX: number, focalY: number): string | null {
  const x = clampFocal(focalX)
  const y = clampFocal(focalY)
  return FOCAL_PRESETS.find((preset) => preset.x === x && preset.y === y)?.id ?? null
}

/**
 * Resolve the CSS triple for a fit + focal point.
 *
 * `center` and `tile` draw at natural size (`auto`); `fill` stretches both
 * axes; `cover` / `contain` scale proportionally. Non-focal fits are pinned to
 * `center` so a stale focal point from a previous fit can't leak in.
 */
export function resolveBackgroundFit(
  position: WallpaperPosition,
  focalX?: number,
  focalY?: number
): BackgroundFit {
  const size =
    position === "fill"
      ? "100% 100%"
      : position === "contain"
        ? "contain"
        : position === "center" || position === "tile"
          ? "auto"
          : "cover"
  const repeat = position === "tile" ? "repeat" : "no-repeat"
  const anchor = supportsFocalPoint(position)
    ? `${clampFocal(focalX)}% ${clampFocal(focalY)}%`
    : "center"
  return { size, repeat, position: anchor }
}

/**
 * The same fit as inline React style, for the gallery tile and any other
 * preview that paints the wallpaper into a small box. `background-attachment`
 * is deliberately absent: previews are their own viewport-independent box.
 */
export function backgroundFitStyle(
  position: WallpaperPosition,
  focalX?: number,
  focalY?: number
): { backgroundSize: string; backgroundRepeat: string; backgroundPosition: string } {
  const fit = resolveBackgroundFit(position, focalX, focalY)
  return {
    backgroundSize: fit.size,
    backgroundRepeat: fit.repeat,
    backgroundPosition: fit.position,
  }
}
