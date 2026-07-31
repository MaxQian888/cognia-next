// Multimodal helpers for the core `read` tool. Node-safe: imports only the
// compact models.dev capability index (no Dexie/Tauri/TS from lib/). Lets `read`
// return a real image content block to vision-capable models and render
// Jupyter notebooks as readable text. PDFs are intentionally NOT inlined here
// (MCP tool results have no document content type, and the Anthropic in-process
// MCP path can't carry one) — `read` returns an honest redirect for those.

import path from "node:path"
import fsp from "node:fs/promises"
import crypto from "node:crypto"

import capabilities from "../../../lib/ai/providers/models-dev-capabilities.json" with { type: "json" }

const SNAPSHOT = /** @type {Record<string, Record<string, { i?: string[] }>>} */ (capabilities)
const MODEL_BY_ID = new Map()
for (const provider of Object.values(SNAPSHOT)) {
  for (const [modelId, model] of Object.entries(provider)) {
    if (!MODEL_BY_ID.has(modelId)) MODEL_BY_ID.set(modelId, model)
  }
}

/** Image extensions `read` will encode as a content block (excludes .svg — that's text). */
export const IMAGE_MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
})

/** Max image bytes inlined as a base64 block (keeps the turn payload sane). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Default page / character ceilings for PDF text extraction. */
export const PDF_MAX_PAGES = 50
export const PDF_MAX_CHARS = 200_000

/**
 * Look up a model's accepted input modalities from the models.dev snapshot.
 * Mirrors `cli/src/agent/attachments/model-modalities.ts`. Unknown → [].
 * @param {string} provider
 * @param {string} model
 * @returns {string[]}
 */
export function modelInputModalities(provider, model) {
  const direct = SNAPSHOT[provider]?.[model]?.i
  if (direct) return direct
  if (typeof model === "string" && model.includes("/")) {
    const slash = model.indexOf("/")
    const org = model.slice(0, slash)
    const id = model.slice(slash + 1)
    const viaOrg = SNAPSHOT[org]?.[id]?.i
    if (viaOrg) return viaOrg
  }
  return MODEL_BY_ID.get(model)?.i ?? []
}

/** Does this model accept image input? */
export function modelSupportsImageInput(provider, model) {
  if (!provider || !model) return false
  return modelInputModalities(provider, model).includes("image")
}

/** Is this path an image we know how to encode? */
export function imageMimeFor(absPath) {
  return IMAGE_MIME[path.extname(absPath).toLowerCase()] ?? null
}

/**
 * Read an image file as a base64 content-block payload.
 * @param {string} absPath
 * @returns {Promise<{ ok: true, data: string, mimeType: string, size: number }
 *   | { ok: false, reason: "unsupported"|"too_large", size?: number }>}
 */
export async function readImageBlock(absPath) {
  const mimeType = imageMimeFor(absPath)
  if (!mimeType) return { ok: false, reason: "unsupported" }
  const buf = await fsp.readFile(absPath)
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large", size: buf.length }
  return { ok: true, data: buf.toString("base64"), mimeType, size: buf.length }
}

/** Truncate a cell's source for the rendered transcript. */
function clampCell(text, max = 4000) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (cell truncated)`
}

/**
 * Render a Jupyter notebook (.ipynb JSON) as readable text: each cell becomes
 * a labelled block (markdown / code), code cells append their text/stream
 * outputs. Throws on malformed JSON (caller surfaces a tool error).
 * @param {string} jsonText
 * @returns {string}
 */
export function renderNotebook(jsonText) {
  const nb = JSON.parse(jsonText)
  const cells = Array.isArray(nb?.cells) ? nb.cells : []
  if (cells.length === 0) return "(empty notebook — no cells)"
  const out = []
  cells.forEach((cell, i) => {
    const kind =
      cell?.cell_type === "code" ? "code" : cell?.cell_type === "markdown" ? "markdown" : "raw"
    const src = Array.isArray(cell?.source) ? cell.source.join("") : String(cell?.source ?? "")
    out.push(`# Cell ${i + 1} [${kind}]`)
    out.push(clampCell(src.trimEnd()))
    if (kind === "code" && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const rendered = cell.outputs
        .map((o) => renderOutput(o))
        .filter((t) => t && t.length > 0)
        .join("\n")
      if (rendered) {
        out.push("## Output:")
        out.push(clampCell(rendered, 2000))
      }
    }
  })
  return out.join("\n")
}

/** Render a single notebook output to text (stream / execute_result / error). */
function renderOutput(o) {
  if (!o || typeof o !== "object") return ""
  if (o.output_type === "stream") {
    return Array.isArray(o.text) ? o.text.join("") : String(o.text ?? "")
  }
  if (o.output_type === "execute_result" || o.output_type === "display_data") {
    const plain = o.data?.["text/plain"]
    return Array.isArray(plain) ? plain.join("") : String(plain ?? "")
  }
  if (o.output_type === "error") {
    const name = o.ename ?? "Error"
    const value = o.evalue ?? ""
    return `${name}: ${value}`
  }
  return ""
}

// ---- PDF text extraction --------------------------------------------------

/**
 * Extract page text from a PDF using pdfjs-dist's legacy (Node-safe) build.
 * Lazy-imported like node-pty so a missing/broken install degrades gracefully:
 * on any failure this returns `{ ok: false }` and `read` falls back to the
 * honest @-attachment redirect rather than crashing.
 *
 * @param {string} absPath
 * @param {{ maxPages?: number, maxChars?: number }} [opts]
 * @returns {Promise<{ ok: true, text: string, pages: number, shown: number, truncated: boolean }
 *   | { ok: false, reason?: string }>}
 */
export async function extractPdfText(absPath, opts = {}) {
  const maxPages = opts.maxPages ?? PDF_MAX_PAGES
  const maxChars = opts.maxChars ?? PDF_MAX_CHARS
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const data = new Uint8Array(await fsp.readFile(absPath))
    // verbosity: 0 (ERRORS only) silences pdfjs's noisy info/warn console output.
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise
    const pageCount = doc.numPages
    const shown = Math.min(pageCount, maxPages)
    const out = []
    let chars = 0
    let charCapped = false
    for (let i = 1; i <= shown; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      let pageText = ""
      for (const it of tc.items) {
        pageText += it.str ?? ""
        if (it.hasEOL) pageText += "\n"
      }
      out.push(`# Page ${i}\n${pageText.trim()}`)
      chars += pageText.length
      if (chars > maxChars) {
        charCapped = true
        break
      }
    }
    if (typeof doc.destroy === "function") await doc.destroy()
    return {
      ok: true,
      text: out.join("\n\n"),
      pages: pageCount,
      shown: charCapped ? out.length : shown,
      truncated: charCapped || pageCount > shown,
    }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
}

// ---- Notebook editing -----------------------------------------------------

/** Detect the JSON indent width used by an .ipynb (Jupyter writes 1 space). */
function detectJsonIndent(jsonText) {
  const m = jsonText.match(/\n( +)"/)
  return m ? m[1].length : 1
}

/**
 * Split a source string into the nbformat list-of-lines form: each line keeps
 * its trailing "\n" except the last. An empty string → [].
 * @param {string} source
 * @returns {string[]}
 */
export function splitNotebookSource(source) {
  const text = String(source ?? "")
  if (text.length === 0) return []
  const parts = text.split("\n")
  return parts
    .map((line, i) => (i < parts.length - 1 ? `${line}\n` : line))
    .filter(
      (_, i, a) =>
        // drop a trailing empty fragment created by a final newline
        !(i === a.length - 1 && a[i] === "")
    )
}

/** Build a fresh notebook cell of the given type. */
function newNotebookCell(cellType, source) {
  const id = crypto.randomUUID().slice(0, 8)
  const sourceLines = splitNotebookSource(source)
  if (cellType === "markdown") {
    return { cell_type: "markdown", id, metadata: {}, source: sourceLines }
  }
  return {
    cell_type: "code",
    id,
    metadata: {},
    execution_count: null,
    outputs: [],
    source: sourceLines,
  }
}

/**
 * Locate a cell index by its nbformat `id` (or legacy `metadata.id`), or by a
 * 1-based cell number. Returns -1 when neither locator is supplied/matches.
 */
function locateCellIndex(cells, { cellId, cellNumber }) {
  if (cellId != null && cellId !== "") {
    return cells.findIndex((c) => c?.id === cellId || c?.metadata?.id === cellId)
  }
  if (cellNumber != null) return cellNumber - 1
  return -1
}

/**
 * Apply a single cell edit to a Jupyter notebook (.ipynb JSON text) and return
 * the re-serialised JSON plus a human-readable summary. Mirrors Claude Code's
 * `NotebookEdit`: `replace` (default) overwrites a located cell's source (and
 * optionally its type), `insert` adds a new cell (after the located cell, or at
 * the top when no locator is given), `delete` removes a located cell.
 *
 * Throws (caller surfaces a tool error) on malformed JSON, an out-of-range or
 * unresolved locator, or a missing source for replace/insert.
 *
 * @param {string} jsonText
 * @param {{ cellId?: string, cellNumber?: number, cellType?: "code"|"markdown",
 *           source?: string, mode?: "replace"|"insert"|"delete" }} opts
 * @returns {{ json: string, message: string, index: number, totalCells: number }}
 */
export function editNotebook(jsonText, opts = {}) {
  const { cellId, cellNumber, cellType, source, mode = "replace" } = opts
  const nb = JSON.parse(jsonText)
  if (!nb || typeof nb !== "object") throw new Error("not a valid notebook (root is not an object)")
  if (!Array.isArray(nb.cells)) nb.cells = []
  const cells = nb.cells
  const indent = detectJsonIndent(jsonText)
  const serialise = () => JSON.stringify(nb, null, indent)

  if (mode === "insert") {
    if (source == null) throw new Error("insert mode requires new_source")
    const at = locateCellIndex(cells, { cellId, cellNumber })
    // After the located cell; at the top when no locator was given/matched.
    const insertAt = at >= 0 ? at + 1 : 0
    if (insertAt > cells.length) throw new Error(`cell index out of range: ${insertAt}`)
    const cell = newNotebookCell(cellType ?? "code", source)
    cells.splice(insertAt, 0, cell)
    return {
      json: serialise(),
      message: `Inserted ${cell.cell_type} cell at position ${insertAt + 1} of ${cells.length}.`,
      index: insertAt,
      totalCells: cells.length,
    }
  }

  // replace / delete need a resolved, in-range index.
  const idx = locateCellIndex(cells, { cellId, cellNumber })
  if (idx < 0 || idx >= cells.length) {
    throw new Error(
      `could not locate cell (cell_id=${cellId ?? "—"}, cell_number=${cellNumber ?? "—"}); notebook has ${cells.length} cells`
    )
  }

  if (mode === "delete") {
    const [removed] = cells.splice(idx, 1)
    return {
      json: serialise(),
      message: `Deleted ${removed?.cell_type ?? "?"} cell ${idx + 1}; ${cells.length} cells remain.`,
      index: idx,
      totalCells: cells.length,
    }
  }

  // replace
  if (source == null) throw new Error("replace mode requires new_source")
  const cell = cells[idx]
  cell.source = splitNotebookSource(source)
  if (cellType && cell.cell_type !== cellType) {
    cell.cell_type = cellType
    if (cellType === "code") {
      cell.outputs = []
      cell.execution_count = null
    } else {
      delete cell.outputs
      delete cell.execution_count
    }
  } else if (cell.cell_type === "code") {
    // Source changed — stale outputs no longer reflect it.
    cell.outputs = []
    cell.execution_count = null
  }
  return {
    json: serialise(),
    message: `Replaced source of ${cell.cell_type} cell ${idx + 1} of ${cells.length}.`,
    index: idx,
    totalCells: cells.length,
  }
}
