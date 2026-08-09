/**
 * Terminal display width of a string, counting East-Asian wide / fullwidth
 * characters (CJK, Hangul, Kana, fullwidth forms, most emoji) as 2 columns and
 * zero-width combining marks as 0. Used for GFM table column alignment so a
 * table with Chinese cells lines up in a monospace terminal — `String.length`
 * (UTF-16 code units) under-counts wide glyphs and leaves the columns ragged.
 *
 * A compact approximation of `wcwidth` / Unicode East_Asian_Width=W|F. It is
 * deliberately self-contained (no `string-width` dependency) to keep the CLI's
 * esbuild bundle lean; the ranges cover everything the agent realistically
 * emits in a table cell.
 */

import { graphemeSegments } from "../text/graphemes"

const ANSI_SEQUENCE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[()#][\s\S]|\x1b[0-~]/g

/** True for code points rendered two columns wide in a monospace terminal. */
function isWide(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    // Hangul Jamo
    (cp <= 0x115f ||
      // CJK Radicals … Hangul Syllables (the bulk of CJK)
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      // Hangul Syllables
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      // CJK Compatibility Ideographs
      (cp >= 0xf900 && cp <= 0xfaff) ||
      // Vertical forms + CJK Compatibility Forms + Small Form Variants
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      // Fullwidth Forms
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      // CJK Extension B+ and Supplementary Ideographic Plane
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  )
}

/** True for zero-width characters (combining marks, ZWJ, variation selectors). */
function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200b || // zero-width space
    cp === 0x200d || // zero-width joiner
    cp === 0xfeff || // zero-width no-break space / BOM
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  )
}

function isEmoji(cp: number): boolean {
  return (
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  )
}

/** Display width of `text` in terminal columns. */
export function stringWidth(text: string): number {
  let width = 0
  for (const { segment } of graphemeSegments(text.replace(ANSI_SEQUENCE, ""))) {
    // Keycap sequences use an ASCII base plus U+20E3, but terminals paint the
    // completed emoji as a two-cell glyph.
    let clusterWidth = segment.includes("\u20e3") ? 2 : 0
    for (const ch of segment) {
      const cp = ch.codePointAt(0)
      if (cp === undefined || isZeroWidth(cp)) continue
      clusterWidth = Math.max(clusterWidth, isWide(cp) || isEmoji(cp) ? 2 : 1)
    }
    width += clusterWidth
  }
  return width
}

/**
 * Truncate `text` to at most `max` display columns, appending `…` when cut.
 * Display-width aware (a wide glyph counts as two columns) via
 * {@link stringWidth}. Lives here next to `stringWidth` so the Markdown table
 * renderer and the tool-detail formatter share one implementation instead of
 * each carrying its own copy.
 */
export function truncateToWidth(text: string, max: number): string {
  if (stringWidth(text) <= max) return text
  if (max <= 1) return "…"
  let out = ""
  let w = 0
  for (const { segment } of graphemeSegments(text)) {
    const cw = stringWidth(segment)
    if (w + cw > max - 1) break
    out += segment
    w += cw
  }
  return out + "…"
}
