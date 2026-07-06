// Optical (snapcompact) frame entry point: pre-normalized text → PNG data URL.
//
// Ports `render_snapcompact_png_sync` from snapcompact.rs. Native-cell bitmap
// shapes encode as indexed PNG; stretched shapes (target cell ≠ font cell)
// rasterize at the natural cell, Lanczos3-resample to the target, and encode as
// RGB. Text normalization / framing / shape selection live in `shape.mjs`.

import { MAX_FRAME_SIZE } from "./constants.mjs"
import { resolveFont, AVAILABLE_FONTS } from "./fonts.mjs"
import { renderBitmap, renderDocBitmap, usedRows, indexedToRgbFloat } from "./raster.mjs"
import { resizeRgb } from "./resample.mjs"
import { encodeIndexedPng, encodeRgbPng } from "./png.mjs"

/** Default font: the eval-winning square 8x8 unscii cell. */
export const DEFAULT_FONT = "8x8"

/**
 * @typedef {Object} SnapcompactRenderOptions
 * @property {number} size        Frame width in px; also bounds grid rows.
 * @property {string} [font]      "8x8" | "5x8". Default "8x8".
 * @property {number} [cellWidth]  Target cell advance px (triggers stretch).
 * @property {number} [cellHeight] Target cell pitch px.
 * @property {"sent"|"bw"} [variant] Ink variant. Default "sent".
 * @property {number} [lineRepeat] Print each line N times. Default 1.
 * @property {boolean} [stretch]  Unset=auto, false=never, true=force.
 * @property {number} [columns]   1 (grid) or 2 (doc). Default 1.
 */

/**
 * @typedef {Object} SnapcompactFrame
 * @property {string} base64     PNG bytes, base64.
 * @property {string} dataUrl    `data:image/png;base64,…`.
 * @property {number} width
 * @property {number} height
 * @property {number} colorType  3 = indexed, 2 = truecolor RGB.
 * @property {number} byteLength PNG byte length.
 */

/**
 * Render one optical frame.
 * @param {string} text  Pre-normalized text (see `shape.mjs`).
 * @param {SnapcompactRenderOptions} options
 * @returns {SnapcompactFrame}
 */
export function renderSnapcompactPng(text, options) {
  const size = options.size
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FRAME_SIZE) {
    throw new Error(`Invalid frame size ${size}: expected 1..=${MAX_FRAME_SIZE}`)
  }
  const fontName = options.font ?? DEFAULT_FONT
  const font = resolveFont(fontName)
  if (!font) {
    throw new Error(
      `Unknown optical font ${JSON.stringify(fontName)}: expected one of ${AVAILABLE_FONTS.join(", ")}`
    )
  }
  const variant = options.variant ?? "sent"
  if (variant !== "sent" && variant !== "bw") {
    throw new Error(`Unknown optical variant ${JSON.stringify(variant)}: expected "sent" or "bw"`)
  }
  const blackInk = variant === "bw"

  const naturalW = font.cellW
  const naturalH = font.cellH
  const targetW = Math.max(1, options.cellWidth ?? naturalW)
  const targetH = Math.max(1, options.cellHeight ?? naturalH)
  const repeat = Math.max(1, options.lineRepeat ?? 1)
  const columns = options.columns ?? 1
  if (columns !== 1 && columns !== 2) {
    throw new Error(`Invalid optical columns ${columns}: expected 1 or 2`)
  }
  const doc = columns === 2

  const grid = {
    cols: Math.floor(size / targetW),
    rows: Math.floor(size / targetH / repeat),
    repeat,
    cellW: targetW,
    cellH: targetH,
  }
  if (grid.cols === 0 || grid.rows === 0) {
    throw new Error(
      `Frame size ${size} cannot fit a ${targetW}x${targetH} cell grid (repeat ${repeat})`
    )
  }

  const used = usedRows(text, grid, doc, true)
  const stretch = options.stretch !== false && (targetW !== naturalW || targetH !== naturalH)

  if (!stretch) {
    const height = used * repeat * grid.cellH
    const pixels = doc
      ? renderDocBitmap(text, size, height, font, grid, blackInk)
      : renderBitmap(text, size, height, font, grid, blackInk)
    const png = encodeIndexedPng(pixels, size, height)
    return frameResult(png, size, height, 3)
  }

  // Stretch shape: rasterize at the font's natural cell on a tight canvas, then
  // Lanczos3-resample to the target cell and paste onto a white frame.
  const native = { ...grid, cellW: naturalW, cellH: naturalH }
  const srcW = grid.cols * naturalW
  const srcH = used * repeat * naturalH
  const dstW = grid.cols * targetW
  const dstH = used * repeat * targetH
  const indexed = doc
    ? renderDocBitmap(text, srcW, srcH, font, native, blackInk)
    : renderBitmap(text, srcW, srcH, font, native, blackInk)
  const resized = resizeRgb(indexedToRgbFloat(indexed), srcW, srcH, dstW, dstH)
  const frame = new Uint8Array(size * dstH * 3).fill(255)
  const copyW = Math.min(dstW, size) * 3
  for (let y = 0; y < dstH; y++) {
    const srcBase = y * dstW * 3
    const dstBase = y * size * 3
    for (let d = 0; d < copyW; d++) {
      frame[dstBase + d] = Math.max(0, Math.min(255, Math.round(resized[srcBase + d])))
    }
  }
  const png = encodeRgbPng(frame, size, dstH)
  return frameResult(png, size, dstH, 2)
}

function frameResult(png, width, height, colorType) {
  const base64 = png.toString("base64")
  return {
    base64,
    dataUrl: `data:image/png;base64,${base64}`,
    width,
    height,
    colorType,
    byteLength: png.length,
  }
}
