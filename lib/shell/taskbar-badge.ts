/**
 * The Windows taskbar's attention count, drawn as pixels.
 *
 * Windows has no count badge (`Window.setBadgeCount` is unsupported there);
 * what it has is the taskbar button's overlay icon — a small image Windows
 * paints over the bottom-right corner of the app's icon. Tauri 2 sets it
 * through `Window.setOverlayIcon(Image)`, and `Image.new(rgba, w, h)` takes
 * straight RGBA, which is exactly what a canvas `getImageData` hands back.
 * `hooks/desktop/use-app-badge.ts` is the only caller.
 *
 * The badge reads like the navigation's own count pills: a filled circle with
 * the number, capped at "99+". The colours come from the app's `--destructive`
 * / `--destructive-foreground` tokens (a taskbar overlay is an alert, and the
 * neutral `--primary` the in-app pills use vanishes against a dark taskbar),
 * with a documented fallback for a token the canvas cannot parse.
 */

import { createSurface } from "@/lib/images/codec"
import { formatBadgeCount } from "@/lib/ui/badge-count"

export interface BadgeColors {
  background: string
  foreground: string
}

/**
 * Used when the theme tokens are missing (no document) or unparseable by the
 * canvas. Tailwind `red-600` on white: legible on both the light and the dark
 * Windows taskbar, and the conventional colour of an overlay count.
 */
export const FALLBACK_BADGE_COLORS: BadgeColors = Object.freeze({
  background: "#dc2626",
  foreground: "#ffffff",
})

/** The badge colours from the live theme tokens, falling back per token. */
export function readBadgeColors(): BadgeColors {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return FALLBACK_BADGE_COLORS
  }
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  return {
    background: token("--destructive") || FALLBACK_BADGE_COLORS.background,
    foreground: token("--destructive-foreground") || FALLBACK_BADGE_COLORS.foreground,
  }
}

/**
 * Pixel edge of the overlay: Windows shows it at the small-icon size (16 px at
 * 100 % scaling), so it is drawn at that size times the display scale for a
 * crisp glyph, within bounds that keep a stray ratio from allocating nonsense.
 */
export function badgeIconSize(devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return Math.min(64, Math.max(16, Math.round(16 * ratio)))
}

export interface BadgePixels {
  /** Straight (not premultiplied) RGBA, row-major, `width * height * 4` bytes. */
  rgba: Uint8Array
  width: number
  height: number
}

/** Font size as a share of the icon edge, shrinking as the label grows. */
function fontScale(label: string): number {
  if (label.length <= 1) return 0.72
  if (label.length === 2) return 0.58
  return 0.44
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Assign a colour, keeping `fallback` if the canvas rejects `value`. */
function setFill(context: Context2D, value: string, fallback: string): void {
  // An unparseable fillStyle is silently ignored by the canvas, so the
  // fallback set first is what stays.
  context.fillStyle = fallback
  context.fillStyle = value
}

/**
 * Draw the badge for `count` and return its pixels.
 *
 * @throws {import("@/lib/images/codec").ImageDecodeError} `unsupported` when
 * the runtime has no 2D canvas.
 */
export function renderTaskbarBadge(
  count: number,
  options: { size: number; colors?: BadgeColors }
): BadgePixels {
  const size = options.size
  const colors = options.colors ?? FALLBACK_BADGE_COLORS
  const label = formatBadgeCount(count)
  const { context } = createSurface(size, size)

  context.clearRect(0, 0, size, size)
  setFill(context, colors.background, FALLBACK_BADGE_COLORS.background)
  context.beginPath()
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  context.fill()

  setFill(context, colors.foreground, FALLBACK_BADGE_COLORS.foreground)
  context.font = `700 ${Math.round(size * fontScale(label))}px "Segoe UI", system-ui, sans-serif`
  context.textAlign = "center"
  context.textBaseline = "middle"
  // Nudged down a hair: `middle` centres the em box, and digits sit high in it.
  context.fillText(label, size / 2, size / 2 + size * 0.04, size * 0.9)

  const { data } = context.getImageData(0, 0, size, size)
  return {
    rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: size,
    height: size,
  }
}
