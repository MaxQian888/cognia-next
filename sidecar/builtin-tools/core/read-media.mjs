// Multimodal helpers for the core `read` tool. Node-safe: imports only the
// bundled models.dev JSON snapshot (no Dexie/Tauri/TS from lib/). Lets `read`
// return a real image content block to vision-capable models and render
// Jupyter notebooks as readable text. PDFs are intentionally NOT inlined here
// (MCP tool results have no document content type, and the Anthropic in-process
// MCP path can't carry one) — `read` returns an honest redirect for those.

import path from "node:path"
import fsp from "node:fs/promises"

import snapshot from "../../../lib/ai/providers/models-dev-snapshot.json" with { type: "json" }

const SNAPSHOT =
  /** @type {Record<string, { models?: Record<string, { modalities?: { input?: string[] } }> }>} */ (
    snapshot
  )

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

/**
 * Look up a model's accepted input modalities from the models.dev snapshot.
 * Mirrors `cli/src/agent/attachments/model-modalities.ts`. Unknown → [].
 * @param {string} provider
 * @param {string} model
 * @returns {string[]}
 */
export function modelInputModalities(provider, model) {
  const direct = SNAPSHOT[provider]?.models?.[model]?.modalities?.input
  if (direct) return direct
  if (typeof model === "string" && model.includes("/")) {
    const slash = model.indexOf("/")
    const org = model.slice(0, slash)
    const id = model.slice(slash + 1)
    const viaOrg = SNAPSHOT[org]?.models?.[id]?.modalities?.input
    if (viaOrg) return viaOrg
  }
  for (const p of Object.values(SNAPSHOT)) {
    const hit = p.models?.[model]?.modalities?.input
    if (hit) return hit
  }
  return []
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
