// Color utilities for VSCode theme imports.
//
// VSCode color theme JSON files express colors as hex strings: `#rgb`,
// `#rrggbb`, or `#rrggbbaa`. Our `CustomTheme.colors` type accepts any
// CSS color string, so we just need to:
//   1. normalise short forms to long forms (`#abc` → `#aabbcc`)
//   2. drop alpha (the cognia palette doesn't use alpha — selection
//      backgrounds are the only place VSCode commonly does, and we map
//      them through opacity instead)
//   3. lighten/darken for missing tokens that we want to derive
//
// Tested independently so the rest of the parser can rely on them.

export interface RGB {
  r: number
  g: number
  b: number
  /** 0..1; only set when the input was 8-digit hex. */
  a?: number
}

const HEX_LONG = /^#([0-9a-f]{6})$/i
const HEX_SHORT = /^#([0-9a-f]{3})$/i
const HEX_LONG_ALPHA = /^#([0-9a-f]{8})$/i
const HEX_SHORT_ALPHA = /^#([0-9a-f]{4})$/i

/**
 * Parse a hex string into RGB(A) components. Returns null for any input
 * that isn't a hex color — callers fall back to a default in that case.
 */
export function parseHex(value: string): RGB | null {
  let m: RegExpMatchArray | null
  if ((m = HEX_LONG.exec(value))) {
    const hex = m[1]
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }
  }
  if ((m = HEX_SHORT.exec(value))) {
    const hex = m[1]
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    }
  }
  if ((m = HEX_LONG_ALPHA.exec(value))) {
    const hex = m[1]
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: parseInt(hex.slice(6, 8), 16) / 255,
    }
  }
  if ((m = HEX_SHORT_ALPHA.exec(value))) {
    const hex = m[1]
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: parseInt(hex[3] + hex[3], 16) / 255,
    }
  }
  return null
}

function pad2(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n))).toString(16)
  return v.length === 1 ? `0${v}` : v
}

/** Format an RGB triple as a 6-digit hex string. Drops alpha. */
export function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${pad2(r)}${pad2(g)}${pad2(b)}`
}

/** Strip alpha from a hex color, returning a 6-digit hex. Returns input if not hex. */
export function stripAlpha(value: string): string {
  const rgb = parseHex(value)
  if (!rgb) return value
  return toHex(rgb)
}

/**
 * Approximate luminance (0..1). We use the simple Rec. 709 formula —
 * good enough to decide "is this color closer to black or white" when
 * picking text color against a parsed background.
 */
export function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * Mix two RGB colors. `t` of 0 returns `a`, 1 returns `b`, 0.5 is the midpoint.
 * Saturating clamp on each channel.
 */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t))
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
  }
}

/** Lighten a color by mixing toward white. amount is 0..1. */
export function lighten(value: string, amount: number): string {
  const rgb = parseHex(value)
  if (!rgb) return value
  return toHex(mix(rgb, { r: 255, g: 255, b: 255 }, amount))
}

/** Darken a color by mixing toward black. amount is 0..1. */
export function darken(value: string, amount: number): string {
  const rgb = parseHex(value)
  if (!rgb) return value
  return toHex(mix(rgb, { r: 0, g: 0, b: 0 }, amount))
}

/**
 * Pick a foreground color (white or near-black) appropriate for the
 * given background, based on luminance. Used when the imported theme
 * doesn't supply a foreground for a UI surface we care about.
 */
export function readableForeground(bg: string): string {
  const rgb = parseHex(bg)
  if (!rgb) return "#0f172a"
  return luminance(rgb) > 0.55 ? "#0f172a" : "#f8fafc"
}
