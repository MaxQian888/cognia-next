// Adaptive shape selection, vision-token budgeting, and multi-frame pagination
// for the optical renderer (ADR-0063 extensions 1 & 4).
//
// The reference `snapcompact.ts` keeps shape selection proprietary; this is our
// open implementation. It maps the target model to a vision "family", picks the
// eval-optimal font/cell/variant for that family, estimates the vision-token
// cost of a frame (token cost tracks image *resolution*, not PNG bytes), and
// paginates archived text across as many frames as needed — closing and
// reopening dim spans across the cut so tool-noise shading survives.

import { DIM_ON, DIM_OFF } from "./constants.mjs"
import { isWide, GUTTER } from "./raster.mjs"

const DIM_ON_CH = String.fromCharCode(DIM_ON)
const DIM_OFF_CH = String.fromCharCode(DIM_OFF)

/** Coarse vision-pricing family for a model id. */
export function visionFamily(modelId) {
  const id = String(modelId ?? "").toLowerCase()
  if (/claude|anthropic/.test(id)) return "anthropic"
  if (/gpt|o[134]\b|openai|azure/.test(id)) return "openai"
  if (/gemini|google/.test(id)) return "google"
  return "default"
}

/**
 * Rough vision-token cost of a `width`×`height` PNG for a family. Formulas are
 * public approximations (Anthropic ≈ w·h/750 capped; OpenAI 512px tiles at
 * 85+170/tile; Gemini 258 per ≤768px crop). Used only for the relative
 * "is optical cheaper than text?" decision, so approximate is fine.
 */
export function estimateImageTokens(width, height, family = "default") {
  switch (family) {
    case "openai": {
      const tiles = Math.ceil(width / 512) * Math.ceil(height / 512)
      return 85 + 170 * tiles
    }
    case "google": {
      if (Math.max(width, height) <= 384) return 258
      return Math.ceil(width / 768) * Math.ceil(height / 768) * 258
    }
    case "anthropic":
    case "default":
    default:
      return Math.min(1600, Math.round((width * height) / 750))
  }
}

/**
 * Eval-optimal base shapes per family (snapcompact notes: bw ink reads best for
 * Anthropic; the 6×6 stretch ("6x6u") is OpenAI-optimal; hue-cycling aids
 * segmentation elsewhere). Callers may override any field.
 */
export const SHAPE_PRESETS = {
  anthropic: { font: "8x8", variant: "bw" },
  openai: { font: "8x8", variant: "sent", cellWidth: 6, cellHeight: 6 },
  google: { font: "8x8", variant: "sent" },
  default: { font: "8x8", variant: "bw" },
}

/** Resolve the shape for a model, applying caller overrides on top. */
export function selectShape({ modelId, overrides = {} } = {}) {
  const family = visionFamily(modelId)
  return { family, ...SHAPE_PRESETS[family], ...stripUndefined(overrides) }
}

function stripUndefined(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

const FONT_CELL = { "8x8": [8, 8], "5x8": [5, 8] }

/** Grid geometry + character capacity of one frame for a shape at `size`. */
export function frameGrid(shape, size) {
  const [natW, natH] = FONT_CELL[shape.font ?? "8x8"] ?? [8, 8]
  const cellW = Math.max(1, shape.cellWidth ?? natW)
  const cellH = Math.max(1, shape.cellHeight ?? natH)
  const repeat = Math.max(1, shape.lineRepeat ?? 1)
  const cols = Math.floor(size / cellW)
  const rows = Math.floor(size / cellH / repeat)
  let capacity
  if ((shape.columns ?? 1) === 2) {
    const colW = Math.floor(Math.max(0, cols - GUTTER) / 2)
    capacity = colW * rows * 2
  } else {
    capacity = cols * rows
  }
  return { cols, rows, cellW, cellH, repeat, capacity }
}

/**
 * Split `text` into ≤`capacity`-cell chunks (one per frame), keeping dim spans
 * balanced: a chunk that ends mid-span closes it and the next chunk reopens it.
 * Wide code points count as two cells, dim toggles as zero.
 * @returns {string[]}
 */
export function paginateCells(text, capacity) {
  if (capacity <= 0) return text ? [text] : []
  const chunks = []
  let cur = ""
  let cells = 0
  let dim = false
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === DIM_ON) {
      dim = true
      cur += ch
      continue
    }
    if (cp === DIM_OFF) {
      dim = false
      cur += ch
      continue
    }
    const units = isWide(cp) ? 2 : 1
    if (cells > 0 && cells + units > capacity) {
      if (dim) cur += DIM_OFF_CH
      chunks.push(cur)
      cur = dim ? DIM_ON_CH : ""
      cells = 0
    }
    cur += ch
    cells += units
  }
  if (cur !== "" && cur !== DIM_ON_CH) chunks.push(cur)
  return chunks
}

/**
 * Plan the optical frames for a normalized transcript.
 * @param {{ text:string, modelId?:string, size?:number, shape?:object,
 *           maxFrames?:number, minSavings?:number }} p
 * @returns {{ frames:string[], shape:object, size:number, family:string,
 *   capacity:number, estImageTokens:number, estTextTokens:number,
 *   worthwhile:boolean, overflow:boolean }}
 */
export function planOpticalFrames({
  text,
  modelId,
  size = 1024,
  shape,
  maxFrames = 4,
  minSavings = 0.15,
}) {
  const resolved = shape ? { family: visionFamily(modelId), ...shape } : selectShape({ modelId })
  const grid = frameGrid(resolved, size)
  const capacity = Math.max(1, grid.capacity)
  const all = paginateCells(text, capacity)
  const overflow = all.length > maxFrames
  const frames = overflow ? all.slice(0, maxFrames) : all

  // Height hugs content: full frames span `size`; the last hugs its fill ratio.
  const family = resolved.family ?? visionFamily(modelId)
  let estImageTokens = 0
  for (let i = 0; i < frames.length; i++) {
    const fill = i < frames.length - 1 ? 1 : Math.min(1, frames[i].length / capacity)
    const height = Math.max(grid.cellH, Math.ceil(size * fill))
    estImageTokens += estimateImageTokens(size, height, family)
  }
  const renderedChars = frames.reduce((n, f) => n + f.length, 0)
  const estTextTokens = Math.round(renderedChars / 4)
  const worthwhile = frames.length > 0 && estImageTokens <= estTextTokens * (1 - minSavings)
  return {
    frames,
    shape: resolved,
    size,
    family,
    capacity,
    estImageTokens,
    estTextTokens,
    worthwhile,
    overflow,
  }
}

/**
 * Pre-wrap plain text into newline-separated lines no wider than `colWidth`
 * cells, for the two-column doc layout. Greedy word wrap; over-long words are
 * hard-split.
 * @returns {string}
 */
export function wrapForDoc(text, colWidth) {
  if (colWidth <= 0) return text
  const lines = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(/ +/)) {
      if (word === "") continue
      let w = word
      while (w.length > colWidth) {
        if (line) {
          lines.push(line)
          line = ""
        }
        lines.push(w.slice(0, colWidth))
        w = w.slice(colWidth)
      }
      if (line.length + (line ? 1 : 0) + w.length > colWidth) {
        lines.push(line)
        line = w
      } else {
        line = line ? `${line} ${w}` : w
      }
    }
    lines.push(line)
  }
  return lines.join("\n")
}
