// Bitmap-font parsing for the optical (snapcompact) compaction renderer.
//
// Ports `parse_hex` / `parse_bdf` / `resolve_font` / `supports` from
// snapcompact.rs. Only the two embeddable public-domain fonts ship inlined:
//   - "8x8" — unscii-8 hex (Latin-1), the eval-winning square cell (default).
//   - "5x8" — X.org misc-fixed BDF, higher legacy density.
// The larger X.org BDFs (6x12 / 8x13) and the CJK TrueType (Silver) are a
// documented extension point (ADR-0063 §Capability boundary): they are too
// heavy to inline, and CJK-heavy text is routed to the text-summary fallback by
// the coverage gate + round-trip readability check rather than mis-rendered.

import { DIM_ON, DIM_OFF, FULL_BLOCK, LINE_FEED } from "./constants.mjs"
import { UNSCII_8_HEX, MISC_5X8_BDF } from "./fonts-data.mjs"

/**
 * @typedef {Object} Glyph
 * @property {number} w    Glyph width in pixels (≤ 8 for the bundled fonts).
 * @property {number} h    Glyph height in pixels.
 * @property {number} xoff X bearing.
 * @property {number} yoff Y bearing (BDF baseline convention).
 * @property {Uint8Array} rows One bitmask per bitmap row, MSB-leftmost.
 */

/**
 * @typedef {Object} BitmapFont
 * @property {Map<number, Glyph>} glyphs Keyed by Unicode code point.
 * @property {number} ascent Baseline offset from the cell top.
 * @property {number} cellW  Natural cell advance (x) in pixels.
 * @property {number} cellH  Natural cell pitch (y) in pixels.
 */

/**
 * Parse a unifont-style `.hex` font (`CODEPOINT:16-hex-digit bitmap`, one byte
 * per row of an 8x8 glyph). Baseline sits at row 7 (ascent 7 with a one-pixel
 * descender row), matching the eval renderer.
 * @param {string} text
 * @returns {BitmapFont}
 */
export function parseHex(text) {
  const glyphs = new Map()
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const cp = Number.parseInt(line.slice(0, colon).trim(), 16)
    if (!Number.isInteger(cp)) continue
    const bits = line.slice(colon + 1).trim()
    if (bits.length !== 16) continue
    const rows = new Uint8Array(8)
    let ok = true
    for (let i = 0; i < 8; i++) {
      const byte = Number.parseInt(bits.slice(i * 2, i * 2 + 2), 16)
      if (!Number.isInteger(byte)) {
        ok = false
        break
      }
      rows[i] = byte
    }
    if (!ok) continue
    glyphs.set(cp, { w: 8, h: 8, xoff: 0, yoff: -1, rows })
  }
  return { glyphs, ascent: 7, cellW: 8, cellH: 8 }
}

/**
 * Parse a BDF font, keeping only the fields the rasterizer needs. Mirrors
 * `parse_bdf`: reads `FONT_ASCENT`, per-glyph `ENCODING` / `BBX` / `BITMAP`.
 * @param {string} text
 * @param {number} cellW
 * @param {number} cellH
 * @returns {BitmapFont}
 */
export function parseBdf(text, cellW, cellH) {
  const glyphs = new Map()
  let ascent = 0
  let enc = -1
  let bbx = [0, 0, 0, 0]
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith("FONT_ASCENT")) {
      ascent = Number.parseInt(line.slice("FONT_ASCENT".length).trim(), 10) || 0
    } else if (line.startsWith("ENCODING")) {
      const v = Number.parseInt(line.slice("ENCODING".length).trim(), 10)
      enc = Number.isInteger(v) ? v : -1
    } else if (line.startsWith("BBX")) {
      const parts = line.slice("BBX".length).trim().split(/\s+/)
      bbx = [0, 1, 2, 3].map((k) => Number.parseInt(parts[k], 10) || 0)
    } else if (line.startsWith("BITMAP")) {
      const rows = []
      for (i++; i < lines.length; i++) {
        if (lines[i].startsWith("ENDCHAR")) break
        rows.push(Number.parseInt(lines[i].trim(), 16) || 0)
      }
      if (enc >= 0) {
        glyphs.set(enc, {
          w: Math.max(0, Math.min(8, bbx[0])),
          h: bbx[1],
          xoff: bbx[2],
          yoff: bbx[3],
          rows: Uint8Array.from(rows),
        })
      }
    }
  }
  return { glyphs, ascent, cellW, cellH }
}

// Lazy, parse-once registry (LazyLock parity).
const CACHE = new Map()

/** @param {string} name @returns {BitmapFont | null} */
export function resolveFont(name) {
  if (CACHE.has(name)) return CACHE.get(name)
  let font = null
  switch (name) {
    case "8x8":
      font = parseHex(UNSCII_8_HEX)
      break
    case "5x8":
      font = parseBdf(MISC_5X8_BDF, 5, 8)
      break
    default:
      font = null
  }
  CACHE.set(name, font)
  return font
}

/** Fonts this build can render (used to validate `options.font`). */
export const AVAILABLE_FONTS = ["8x8", "5x8"]

/** True when `font` can draw `code` (control codes are handled outside lookup). */
export function fontSupports(font, code) {
  if (code === DIM_ON || code === DIM_OFF || code === FULL_BLOCK || code === LINE_FEED) {
    return true
  }
  return font.glyphs.has(code)
}

/**
 * Return the subset of `chars` the named font can render (renderer control
 * codes count as renderable — they are interpreted outside font lookup).
 * Mirrors `snapcompact_supported_chars`.
 * @param {string} fontName
 * @param {string} chars
 * @returns {string}
 */
export function supportedChars(fontName, chars) {
  const font = resolveFont(fontName)
  if (!font) {
    throw new Error(
      `Unknown optical font ${JSON.stringify(fontName)}: expected one of ${AVAILABLE_FONTS.join(", ")}`
    )
  }
  let out = ""
  for (const ch of chars) {
    if (fontSupports(font, ch.codePointAt(0))) out += ch
  }
  return out
}
