/**
 * Terminal display width of a string, counting East-Asian wide / fullwidth
 * characters (CJK, Hangul, Kana, fullwidth forms, most emoji) as 2 columns and
 * zero-width combining marks as 0. Used for GFM table column alignment so a
 * table with Chinese cells lines up in a monospace terminal — `String.length`
 * (UTF-16 code units) under-counts wide glyphs and leaves the columns ragged.
 *
 * The standalone Bun runtime uses Bun's native terminal-width primitives. The
 * compact `wcwidth` approximation below remains as the Node/Jest fallback so
 * this module stays portable without adding a `string-width` dependency.
 */

import { graphemeSegments } from "../text/graphemes"

interface BunTextUtils {
  stringWidth(text: string): number
  sliceAnsi(
    text: string,
    start?: number,
    end?: number,
    options?: { ellipsis?: string; ambiguousIsNarrow?: boolean }
  ): string
}

export function resolveBunTextUtils(
  runtime: Partial<BunTextUtils> | undefined
): Partial<BunTextUtils> | undefined {
  if (!runtime) return undefined
  return {
    ...(typeof runtime.stringWidth === "function"
      ? { stringWidth: runtime.stringWidth.bind(runtime) }
      : {}),
    ...(typeof runtime.sliceAnsi === "function"
      ? { sliceAnsi: runtime.sliceAnsi.bind(runtime) }
      : {}),
  }
}

const bunTextUtils = resolveBunTextUtils(
  (globalThis as typeof globalThis & { Bun?: Partial<BunTextUtils> }).Bun
)

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

/**
 * The code points in Miscellaneous Symbols / Dingbats (U+2600..U+27BF) that
 * Unicode gives `Emoji_Presentation=Yes`, i.e. the ones a terminal paints two
 * columns wide on their own. The rest of that block (`✓ ✗ ✎ ★ ☰ ❯` …) is
 * East-Asian *Ambiguous* and renders in ONE column, which is how this TUI has
 * always drawn them.
 *
 * The whole block used to be measured as emoji, so every `✓`/`✗` in a status
 * glyph, a tool card or a list row counted double: right-aligned columns came
 * out a cell short and wrap budgets under-filled by one per glyph.
 */
const DINGBAT_EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
]

function isEmoji(cp: number): boolean {
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true
  if (cp >= 0x1f300 && cp <= 0x1faff) return true
  if (cp < 0x2600 || cp > 0x27bf) return false
  return DINGBAT_EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

function fallbackStringWidth(text: string): number {
  let width = 0
  for (const { segment } of graphemeSegments(text.replace(ANSI_SEQUENCE, ""))) {
    // Keycap sequences use an ASCII base plus U+20E3, and U+FE0F asks for the
    // emoji *presentation* of an otherwise-narrow symbol ("☝️"). Terminals paint
    // both as a two-cell glyph, whatever the base character measures alone.
    let clusterWidth = segment.includes("\u20e3") || segment.includes("\ufe0f") ? 2 : 0
    for (const ch of segment) {
      const cp = ch.codePointAt(0)
      if (cp === undefined || isZeroWidth(cp)) continue
      clusterWidth = Math.max(clusterWidth, isWide(cp) || isEmoji(cp) ? 2 : 1)
    }
    width += clusterWidth
  }
  return width
}

/** Display width of `text` in terminal columns. */
export function stringWidth(text: string): number {
  return bunTextUtils?.stringWidth?.(text) ?? fallbackStringWidth(text)
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
  if (bunTextUtils?.sliceAnsi) {
    return bunTextUtils.sliceAnsi(text, 0, max, { ellipsis: "…" })
  }
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
