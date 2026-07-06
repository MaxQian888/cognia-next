// Palette-indexed rasterization for the optical (snapcompact) renderer.
//
// Ports the bitmap-font raster paths from snapcompact.rs: cell geometry, the
// grid renderer, and the two-column "doc" renderer, with sentence-hue cycling,
// dim spans (U+000E/F), the full-block cell fill (U+2588), and line-repeat
// highlight bands. The TrueType/Silver fallback branches are intentionally
// dropped (no CJK font is inlined); wide code points that reach here without a
// bitmap glyph simply leave a blank cell — the normalizer's coverage gate keeps
// them out in practice (ADR-0063).

import {
  PALETTE,
  INK_COLORS,
  INK_BLACK,
  BG_REPEAT,
  INK_DIM,
  DIM_ON,
  DIM_OFF,
  FULL_BLOCK,
  LINE_FEED,
} from "./constants.mjs"

/** @typedef {{cols:number, rows:number, repeat:number, cellW:number, cellH:number}} Grid */

const isTerminator = (code) => code === 0x2e || code === 0x21 || code === 0x3f

/**
 * East Asian Wide / Fullwidth code points that occupy two grid cells in a
 * narrow bitmap shape. Kept for layout parity with the reference renderer and
 * the pagination math even though this build has no CJK glyphs to draw.
 */
export function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0x2f00 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  )
}

/** Cells one code point consumes: 0 for dim toggles, 2 for wide (narrow-cell
 * shapes), 1 otherwise. */
export function cellUnits(code, wideCells) {
  if (code === DIM_ON || code === DIM_OFF) return 0
  if (wideCells && isWide(code)) return 2
  return 1
}

/**
 * Advance the running cell cursor for one code point, padding one cell when a
 * wide glyph would straddle the right edge. Returns `[cellToDrawAt, units,
 * nextCursor]` or `null` for a zero-width toggle.
 */
export function placeCell(cursor, cols, code, wideCells) {
  const units = cellUnits(code, wideCells)
  if (units === 0) return null
  let cell = cursor
  if (units === 2 && cols >= 2 && cell % cols === cols - 1) cell += 1
  return [cell, units, cell + units]
}

/** Grid rows the text actually occupies (so the canvas height hugs content). */
export function usedRows(text, grid, doc, wideCells) {
  let rows
  if (doc) {
    rows = text.split("\n").length
  } else {
    let cursor = 0
    for (const ch of text) {
      const placed = placeCell(cursor, grid.cols, ch.codePointAt(0), wideCells)
      if (placed) cursor = placed[2]
    }
    rows = Math.ceil(cursor / grid.cols)
  }
  return Math.min(Math.max(rows, 1), grid.rows)
}

function fillRepeatBands(pixels, width, height, grid) {
  if (grid.repeat <= 1) return
  for (let row = 0; row < grid.rows; row++) {
    for (let copy = 1; copy < grid.repeat; copy++) {
      const bandTop = (row * grid.repeat + copy) * grid.cellH
      for (let y = bandTop; y < Math.min(bandTop + grid.cellH, height); y++) {
        pixels.fill(BG_REPEAT, y * width, y * width + width)
      }
    }
  }
}

function blitGlyph(pixels, width, height, glyph, left, top, ink) {
  for (let r = 0; r < glyph.rows.length; r++) {
    const bits = glyph.rows[r]
    if (bits === 0) continue
    const y = top + r
    if (y < 0 || y >= height) continue
    const rowBase = y * width
    for (let b = 0; b < glyph.w; b++) {
      if (bits & (0x80 >> b)) {
        const x = left + b
        if (x >= 0 && x < width) pixels[rowBase + x] = ink
      }
    }
  }
}

function fillCell(pixels, width, height, grid, xOrigin, row, ink) {
  const x0 = Math.min(xOrigin, width)
  const x1 = Math.min(xOrigin + grid.cellW, width)
  if (x0 >= x1) return
  for (let copy = 0; copy < grid.repeat; copy++) {
    const top = (row * grid.repeat + copy) * grid.cellH
    for (let y = top; y < Math.min(top + grid.cellH, height); y++) {
      pixels.fill(ink, y * width + x0, y * width + x1)
    }
  }
}

/**
 * Rasterize `text` onto a `width`×`height` palette-indexed bitmap, row-major on
 * the grid's cell box. Ink cycles through six hues at sentence boundaries
 * unless `blackInk`; U+000E/F toggle dim ink; U+2588 fills its cell black.
 * @returns {Uint8Array}
 */
export function renderBitmap(text, width, height, font, grid, blackInk) {
  const pixels = new Uint8Array(width * height) // 0 = white background
  const capacity = grid.cols * grid.rows
  if (capacity === 0) return pixels
  fillRepeatBands(pixels, width, height, grid)
  const codes = Array.from(text, (ch) => ch.codePointAt(0))
  let sentence = 0
  let dim = false
  let cursor = 0
  for (let i = 0; i < codes.length; i++) {
    if (cursor >= capacity) break
    const code = codes[i]
    if (code === DIM_ON) {
      dim = true
      continue
    }
    if (code === DIM_OFF) {
      dim = false
      continue
    }
    const ink = dim ? INK_DIM : blackInk ? INK_BLACK : 1 + (sentence % INK_COLORS)
    if (isTerminator(code) && (codes[i + 1] === 0x20 || codes[i + 1] === FULL_BLOCK)) {
      sentence += 1
    }
    const placed = placeCell(cursor, grid.cols, code, true)
    if (!placed) continue
    const [at, , next] = placed
    cursor = next
    if (at >= capacity) break
    const row = Math.floor(at / grid.cols)
    const col = at - row * grid.cols
    if (code === FULL_BLOCK) {
      fillCell(pixels, width, height, grid, col * grid.cellW, row, INK_BLACK)
      continue
    }
    const glyph = font.glyphs.get(code)
    if (glyph && glyph.rows.length > 0) {
      const left = col * grid.cellW + glyph.xoff
      for (let copy = 0; copy < grid.repeat; copy++) {
        const cellTop = (row * grid.repeat + copy) * grid.cellH
        const top = cellTop + font.ascent - glyph.h - glyph.yoff
        blitGlyph(pixels, width, height, glyph, left, top, ink)
      }
    }
  }
  return pixels
}

/** Character cells between the two doc columns (eval `exp14` layout). */
export const GUTTER = 3

/**
 * Rasterize pre-wrapped text as a two-column "doc" page. Input splits on '\n'
 * (zero-width): line `li` lands at column `li / rows`, row `li % rows`. Lines
 * longer than the column width are clipped (the caller pre-wraps).
 * @returns {Uint8Array}
 */
export function renderDocBitmap(text, width, height, font, grid, blackInk) {
  const pixels = new Uint8Array(width * height)
  const colW = Math.floor(Math.max(0, grid.cols - GUTTER) / 2)
  if (colW === 0 || grid.rows === 0) return pixels
  fillRepeatBands(pixels, width, height, grid)
  const codes = Array.from(text, (ch) => ch.codePointAt(0))
  let sentence = 0
  let dim = false
  let line = 0
  let col = 0
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code === DIM_ON) {
      dim = true
      continue
    }
    if (code === DIM_OFF) {
      dim = false
      continue
    }
    if (code === LINE_FEED) {
      line += 1
      col = 0
      if (line >= grid.rows * 2) break
      continue
    }
    const ink = dim ? INK_DIM : blackInk ? INK_BLACK : 1 + (sentence % INK_COLORS)
    if (
      isTerminator(code) &&
      (codes[i + 1] === 0x20 || codes[i + 1] === LINE_FEED || codes[i + 1] === FULL_BLOCK)
    ) {
      sentence += 1
    }
    const units = cellUnits(code, true)
    let cell = col
    if (units === 2 && colW >= 2 && cell === colW - 1) cell += 1
    col = cell + units
    if (cell + units > colW) continue // clip past the column width
    const column = Math.floor(line / grid.rows)
    const row = line - column * grid.rows
    const xOrigin = column * (colW + GUTTER) * grid.cellW
    if (code === FULL_BLOCK) {
      fillCell(pixels, width, height, grid, xOrigin + cell * grid.cellW, row, INK_BLACK)
      continue
    }
    const glyph = font.glyphs.get(code)
    if (glyph && glyph.rows.length > 0) {
      const left = xOrigin + cell * grid.cellW + glyph.xoff
      for (let copy = 0; copy < grid.repeat; copy++) {
        const cellTop = (row * grid.repeat + copy) * grid.cellH
        const top = cellTop + font.ascent - glyph.h - glyph.yoff
        blitGlyph(pixels, width, height, glyph, left, top, ink)
      }
    }
  }
  return pixels
}

/** Convert an indexed pixel buffer to an interleaved RGB f32 buffer (for the
 * Lanczos stretch path). */
export function indexedToRgbFloat(indexed) {
  const rgb = new Float32Array(indexed.length * 3)
  for (let i = 0; i < indexed.length; i++) {
    const [r, g, b] = PALETTE[indexed[i]]
    rgb[i * 3] = r
    rgb[i * 3 + 1] = g
    rgb[i * 3 + 2] = b
  }
  return rgb
}
