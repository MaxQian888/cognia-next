/**
 * RGB and HSL conversions, shared by every adjustment that has to reason about
 * hue or saturation rather than about channel levels.
 *
 * These were previously private to `lib/plugin/api/media-api.ts`. Hoisting them
 * is what lets the chat workbench and the plugin Media API produce identical
 * pixels for the same adjustment, which is the whole point of one engine.
 */

/** Clamp to the 0..1 range used by the HSL side of the conversions. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Clamp to the 0..255 range used by the RGB side. */
export function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/**
 * Rec. 601 luma. Chosen over Rec. 709 because it is what the existing plugin
 * saturation filter used, and changing it would silently re-grade every image
 * a plugin has already processed.
 */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** `r`, `g`, `b` in 0..255 to `[h, s, l]` in 0..1. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255

  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2

  if (max === min) return [0, 0, l]

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6

  return [h, s, l]
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t
  if (tt < 0) tt += 1
  if (tt > 1) tt -= 1
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

/** `[h, s, l]` in 0..1 back to `r`, `g`, `b` in 0..255. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ]
}
