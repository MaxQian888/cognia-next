/**
 * The storyboard: N sampled frames tiled into one image with their timestamps.
 *
 * One image block instead of N is what makes it the default (decision D5): a
 * vision model reads a labelled grid well, and it costs one image's tokens.
 *
 * Composed in `PixelBuffer` space rather than on a canvas, including the
 * labels. Timestamps use a built-in bitmap font of the twelve glyphs a timecode
 * needs, so the grid is byte-identical in WKWebView, WebView2, Chromium and the
 * `node` test project — canvas text would depend on whichever fonts a shell
 * happens to ship, and could not be asserted at all.
 */

import { createPixelBuffer, type PixelBuffer } from "@/lib/images/pixel-buffer"
import { resizeBuffer } from "@/lib/images/transform"

/** Anthropic resamples anything past this long edge; larger only costs bytes. */
export const STORYBOARD_MAX_LONG_EDGE = 1568
/** …and past ~1.15 megapixels in total, so the grid's cells share that budget. */
export const STORYBOARD_MAX_PIXELS = 1_150_000
export const STORYBOARD_GAP = 4
/** A cell below this edge is unreadable, whatever the frame count. */
export const STORYBOARD_MIN_CELL_EDGE = 48
export const STORYBOARD_BACKGROUND: readonly [number, number, number] = [24, 24, 24]
/** What a transparent GIF pixel is flattened onto before JPEG encoding. */
export const TRANSPARENT_FLATTEN_COLOR: readonly [number, number, number] = [255, 255, 255]

export interface StoryboardLayout {
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
  gap: number
  width: number
  height: number
}

/**
 * Grid for `count` frames of `sourceWidth × sourceHeight`: the column count
 * that gives the largest cells within the long edge and the pixel budget. A cell is never larger than the source frame, except that a tiny source
 * (an emoji-sized GIF) is raised to {@link STORYBOARD_MIN_CELL_EDGE} so its
 * timestamp still fits.
 */
export function storyboardLayout(
  count: number,
  sourceWidth: number,
  sourceHeight: number,
  maxLongEdge = STORYBOARD_MAX_LONG_EDGE,
  gap = STORYBOARD_GAP
): StoryboardLayout {
  const n = Math.max(1, Math.floor(count))
  const aspect = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 16 / 9

  // The widest cell a `c`-column grid allows under both limits the model
  // applies: the long edge, and the total pixel budget shared by every cell.
  const cellWidthFor = (c: number) => {
    const r = Math.ceil(n / c)
    const byWidth = (maxLongEdge - gap * (c - 1)) / c
    const byHeight = ((maxLongEdge - gap * (r - 1)) / r) * aspect
    const byArea = Math.sqrt((STORYBOARD_MAX_PIXELS / (c * r)) * aspect)
    return Math.min(byWidth, byHeight, byArea)
  }

  // Largest cells win; among equals, fewer empty cells, then more columns.
  let columns = 1
  let best = { width: -1, empty: Infinity }
  for (let c = 1; c <= n; c++) {
    const width = Math.floor(cellWidthFor(c))
    const empty = c * Math.ceil(n / c) - n
    if (width > best.width || (width === best.width && empty <= best.empty)) {
      best = { width, empty }
      columns = c
    }
  }
  const rows = Math.ceil(n / columns)

  let cellWidth = Math.floor(cellWidthFor(columns))
  if (sourceWidth > 0) cellWidth = Math.min(cellWidth, sourceWidth)
  let cellHeight = Math.round(cellWidth / aspect)
  if (cellWidth < STORYBOARD_MIN_CELL_EDGE || cellHeight < STORYBOARD_MIN_CELL_EDGE) {
    const scale = STORYBOARD_MIN_CELL_EDGE / Math.min(cellWidth, cellHeight || 1)
    cellWidth = Math.round(cellWidth * scale)
    cellHeight = Math.round(cellHeight * scale)
  }
  cellWidth = Math.max(1, cellWidth)
  cellHeight = Math.max(1, cellHeight)

  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    gap,
    width: columns * cellWidth + (columns - 1) * gap,
    height: rows * cellHeight + (rows - 1) * gap,
  }
}

/** Composite `buffer` over an opaque colour. JPEG has no alpha to keep. */
export function flattenOnto(
  buffer: PixelBuffer,
  rgb: readonly [number, number, number]
): PixelBuffer {
  const out = createPixelBuffer(buffer.width, buffer.height)
  const { data } = buffer
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255
    out.data[i] = Math.round(data[i]! * a + rgb[0] * (1 - a))
    out.data[i + 1] = Math.round(data[i + 1]! * a + rgb[1] * (1 - a))
    out.data[i + 2] = Math.round(data[i + 2]! * a + rgb[2] * (1 - a))
    out.data[i + 3] = 255
  }
  return out
}

/**
 * Scale to fit inside `maxWidth × maxHeight`, keeping the aspect ratio. Only
 * shrinks unless `allowUpscale`, which the storyboard sets so every cell is
 * filled the same way.
 */
export function fitBuffer(
  buffer: PixelBuffer,
  maxWidth: number,
  maxHeight: number,
  allowUpscale = false
): PixelBuffer {
  const fit = Math.min(maxWidth / buffer.width, maxHeight / buffer.height)
  const scale = allowUpscale ? fit : Math.min(1, fit)
  if (Math.abs(scale - 1) < 1e-9) return buffer
  return resizeBuffer(
    buffer,
    Math.max(1, Math.round(buffer.width * scale)),
    Math.max(1, Math.round(buffer.height * scale))
  )
}

// ── Timecode bitmap font ─────────────────────────────────────────────────────
// 3×5 glyphs, rows top to bottom, `#` = ink.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", "###", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", "..#", "..#", "..#"],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  ":": ["...", ".#.", "...", ".#.", "..."],
  ".": ["...", "...", "...", "...", ".#."],
}
const GLYPH_WIDTH = 3
const GLYPH_HEIGHT = 5

/** Pixel size of `text` rendered at `scale` (1 px glyph spacing per scale unit). */
export function measureTimecode(text: string, scale: number): { width: number; height: number } {
  const glyphs = [...text].filter((ch) => GLYPHS[ch])
  if (glyphs.length === 0) return { width: 0, height: 0 }
  return {
    width: (glyphs.length * (GLYPH_WIDTH + 1) - 1) * scale,
    height: GLYPH_HEIGHT * scale,
  }
}

function blendPixel(
  buffer: PixelBuffer,
  x: number,
  y: number,
  rgb: readonly [number, number, number],
  alpha: number
) {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return
  const i = (y * buffer.width + x) * 4
  const d = buffer.data
  d[i] = Math.round(d[i]! * (1 - alpha) + rgb[0] * alpha)
  d[i + 1] = Math.round(d[i + 1]! * (1 - alpha) + rgb[1] * alpha)
  d[i + 2] = Math.round(d[i + 2]! * (1 - alpha) + rgb[2] * alpha)
  d[i + 3] = 255
}

/**
 * Draw a timecode label with its top-left at (`x`, `y`): a translucent dark
 * plate for contrast on any frame, white glyphs on top. Characters outside the
 * font are skipped rather than drawn as boxes.
 */
export function drawTimecode(
  buffer: PixelBuffer,
  x: number,
  y: number,
  text: string,
  scale: number
) {
  const s = Math.max(1, Math.floor(scale))
  const { width, height } = measureTimecode(text, s)
  if (width === 0) return
  const pad = 2 * s
  for (let py = y; py < y + height + pad * 2; py++) {
    for (let px = x; px < x + width + pad * 2; px++) blendPixel(buffer, px, py, [0, 0, 0], 0.62)
  }
  let cursor = x + pad
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (!glyph) continue
    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (glyph[gy]![gx] !== "#") continue
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            blendPixel(buffer, cursor + gx * s + dx, y + pad + gy * s + dy, [255, 255, 255], 1)
          }
        }
      }
    }
    cursor += (GLYPH_WIDTH + 1) * s
  }
}

/** Glyph scale for a cell: legible at a glance, never dominating the frame. */
export function timecodeScaleFor(cellHeight: number): number {
  return Math.max(1, Math.min(6, Math.round(cellHeight / 70)))
}

/**
 * Tile `frames` (any size; each is fitted and centred in its cell) with
 * `labels` stamped bottom-left, in reading order.
 */
export function composeStoryboard(
  frames: readonly PixelBuffer[],
  labels: readonly string[],
  layout: StoryboardLayout
): PixelBuffer {
  const out = createPixelBuffer(layout.width, layout.height)
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = STORYBOARD_BACKGROUND[0]
    out.data[i + 1] = STORYBOARD_BACKGROUND[1]
    out.data[i + 2] = STORYBOARD_BACKGROUND[2]
    out.data[i + 3] = 255
  }
  const scale = timecodeScaleFor(layout.cellHeight)

  frames.slice(0, layout.columns * layout.rows).forEach((frame, index) => {
    const column = index % layout.columns
    const row = Math.floor(index / layout.columns)
    const cellX = column * (layout.cellWidth + layout.gap)
    const cellY = row * (layout.cellHeight + layout.gap)
    const fitted = flattenOnto(
      fitBuffer(frame, layout.cellWidth, layout.cellHeight, true),
      TRANSPARENT_FLATTEN_COLOR
    )
    const offsetX = cellX + Math.floor((layout.cellWidth - fitted.width) / 2)
    const offsetY = cellY + Math.floor((layout.cellHeight - fitted.height) / 2)
    for (let y = 0; y < fitted.height; y++) {
      const src = y * fitted.width * 4
      const dst = ((offsetY + y) * layout.width + offsetX) * 4
      out.data.set(fitted.data.subarray(src, src + fitted.width * 4), dst)
    }
    const label = labels[index]
    if (label) {
      const { height } = measureTimecode(label, scale)
      const margin = 3 * scale
      drawTimecode(
        out,
        cellX + margin,
        cellY + layout.cellHeight - height - 4 * scale - margin,
        label,
        scale
      )
    }
  })

  return out
}
