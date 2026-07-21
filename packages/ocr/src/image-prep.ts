/**
 * Image and page-range helpers shared across OCR providers.
 *
 * Two layers of responsibility live here:
 *   1. Normalize an `OcrSource` into raw `{ bytes, mimeType }` providers can
 *      hand to a cloud API or a native binding (`normalizeImage`,
 *      `decodeDataUrl`, `bytesToBase64`, `bytesToDataUrl`).
 *   2. Pure value helpers reused by `auto-router`, `index`, and provider
 *      implementations (page-range parsing, language normalization, format
 *      resolution, MIME predicates, multi-page combine).
 *
 * Browser-side resize uses `OffscreenCanvas` when available, else `<canvas>`.
 * The resize call degrades gracefully under jsdom (no canvas): it returns the
 * input unchanged so tests don't need a polyfill.
 */

import type { OcrInput, OcrSource } from "./types"
import { readBlobAsArrayBuffer } from "./blob-utils"

// ─── Data-URL decoding ──────────────────────────────────────────────────────

export interface DecodedDataUrl {
  bytes: Uint8Array
  mimeType: string
}

const DATA_URL_RE = /^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$/

/** Decode a `data:<mime>;base64,<payload>` URL into bytes + mime. */
export function decodeDataUrl(dataUrl: string): DecodedDataUrl | null {
  const match = DATA_URL_RE.exec(dataUrl)
  if (!match) return null
  const mimeType = match[1]!
  const b64 = match[2]!
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary")
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, mimeType }
}

// ─── Source normalization ───────────────────────────────────────────────────

export interface NormalizedImageInput {
  bytes: Uint8Array
  mimeType: string
  /** Filename hint (basename only) when the source carried one. */
  name?: string
}

/**
 * Resolve an inline `OcrSource` to raw bytes. `file-path` and
 * `attachment-id` sources have to be resolved upstream — they need access to
 * the Tauri fs / attachment store this module doesn't import. The discriminant
 * is preserved in the thrown error so callers can route correctly.
 */
export async function normalizeImage(source: OcrSource): Promise<NormalizedImageInput> {
  if (source.kind === "blob") {
    const buf = await readBlobAsArrayBuffer(source.blob)
    const bytes = new Uint8Array(buf)
    return { bytes, mimeType: source.mimeType || source.blob.type || "application/octet-stream" }
  }
  if (source.kind === "data-url") {
    const decoded = decodeDataUrl(source.dataUrl)
    if (!decoded) throw new Error("normalizeImage: data URL must be base64-encoded")
    return { bytes: decoded.bytes, mimeType: source.mimeType || decoded.mimeType }
  }
  if (source.kind === "file-path") {
    throw new Error("normalizeImage: file-path source must be read into a blob/data-url first")
  }
  throw new Error("normalizeImage: attachment-id source must be resolved by the caller first")
}

/**
 * Test-friendly variant: returns null for sources that need upstream
 * resolution (file-path / attachment-id) instead of throwing. Used in places
 * where the caller wants a fast "is this inline?" check before dispatching.
 */
export async function sourceToBytes(source: OcrSource): Promise<DecodedDataUrl | null> {
  if (source.kind === "data-url") return decodeDataUrl(source.dataUrl)
  if (source.kind === "blob") {
    const buf = await readBlobAsArrayBuffer(source.blob)
    return { bytes: new Uint8Array(buf), mimeType: source.mimeType || source.blob.type || "" }
  }
  return null
}

// ─── Base64 encoding ────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64")
  }
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  if (typeof btoa === "function") return btoa(bin)
  throw new Error("bytesToBase64: no Buffer or btoa available")
}

export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`
}

// ─── Page-range parsing ─────────────────────────────────────────────────────

/**
 * Parse "1,3-5,9" syntax into a 1-based, sorted, deduplicated list. Returns
 * null when the spec is undefined or empty (caller should treat as "all
 * pages"). Throws on malformed input. When `totalPages` is provided, pages
 * beyond `totalPages` are dropped silently.
 */
export function parsePageRange(spec: string | undefined, totalPages?: number): number[] | null {
  if (spec === undefined) return null
  const trimmed = spec.trim()
  if (trimmed === "") return null
  if (totalPages !== undefined && (!Number.isInteger(totalPages) || totalPages < 1)) {
    throw new Error(`Invalid totalPages: ${totalPages}`)
  }
  const pages = new Set<number>()
  for (const part of trimmed.split(",")) {
    const segment = part.trim()
    if (segment === "") continue
    if (segment.includes("-")) {
      const [lo, hi] = segment.split("-").map((s) => s.trim())
      const loNum = Number(lo)
      const hiNum = Number(hi)
      if (!Number.isInteger(loNum) || !Number.isInteger(hiNum) || loNum < 1 || hiNum < loNum) {
        throw new Error(`Invalid page range segment: "${segment}"`)
      }
      for (let p = loNum; p <= hiNum; p++) pages.add(p)
    } else {
      const num = Number(segment)
      if (!Number.isInteger(num) || num < 1) {
        throw new Error(`Invalid page number: "${segment}"`)
      }
      pages.add(num)
    }
  }
  let out = Array.from(pages).sort((a, b) => a - b)
  if (totalPages !== undefined) {
    out = out.filter((p) => p <= totalPages)
  }
  return out
}

// ─── Language normalization ─────────────────────────────────────────────────

export const DEFAULT_OCR_LANGUAGES = ["en"] as const

export function normalizeLanguages(
  inputLangs: readonly string[] | undefined,
  settingsLangs: readonly string[] | undefined
): string[] {
  const source =
    inputLangs && inputLangs.length > 0
      ? inputLangs
      : settingsLangs && settingsLangs.length > 0
        ? settingsLangs
        : DEFAULT_OCR_LANGUAGES
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of source) {
    if (typeof raw !== "string") continue
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export function effectiveFormat(
  input: Pick<OcrInput, "format">,
  fallback: OcrInput["format"]
): NonNullable<OcrInput["format"]> {
  return input.format ?? fallback ?? "markdown"
}

// ─── MIME predicates ────────────────────────────────────────────────────────

export function isImageMimeType(mime: string): boolean {
  return (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/jpg" ||
    mime === "image/webp" ||
    mime === "image/gif" ||
    mime === "image/bmp" ||
    mime === "image/tiff" ||
    mime === "image/heic" ||
    mime === "image/heif"
  )
}

export function isPdfMimeType(mime: string): boolean {
  return mime === "application/pdf"
}

// ─── Multi-page combine ─────────────────────────────────────────────────────

export function combinePageMarkdown(
  pages: Array<{ pageNumber: number; markdown: string }>
): string {
  if (pages.length === 0) return ""
  if (pages.length === 1) return pages[0]!.markdown
  return pages.map((p) => `<!-- page ${p.pageNumber} -->\n${p.markdown}`).join("\n\n---\n\n")
}

export function combinePageText(pages: Array<{ pageNumber: number; text: string }>): string {
  if (pages.length === 0) return ""
  if (pages.length === 1) return pages[0]!.text
  return pages.map((p) => p.text).join("\n\n")
}

// ─── Downscale (canvas-backed) ──────────────────────────────────────────────

/**
 * Downscale `bytes` so the long edge is at most `maxLongEdge` pixels. Returns
 * the original payload unchanged when the input is already small enough or
 * when the runtime can't decode images (jsdom + node). Always preserves the
 * original mime type — callers asking for a different output mime have to
 * re-encode separately.
 */
export async function downscaleImage(
  bytes: Uint8Array,
  mimeType: string,
  maxLongEdge: number
): Promise<NormalizedImageInput> {
  if (!Number.isFinite(maxLongEdge) || maxLongEdge <= 0) {
    return { bytes, mimeType }
  }
  if (typeof document === "undefined" && typeof OffscreenCanvas === "undefined") {
    return { bytes, mimeType }
  }
  const bitmap = await decodeBitmap(bytes, mimeType)
  if (!bitmap) return { bytes, mimeType }
  const longEdge = Math.max(bitmap.width, bitmap.height)
  if (longEdge <= maxLongEdge) {
    closeBitmap(bitmap)
    return { bytes, mimeType }
  }
  const scale = maxLongEdge / longEdge
  const targetW = Math.max(1, Math.round(bitmap.width * scale))
  const targetH = Math.max(1, Math.round(bitmap.height * scale))
  const blob = await rasterToBlob(bitmap, targetW, targetH, mimeType)
  closeBitmap(bitmap)
  if (!blob) return { bytes, mimeType }
  const buf = await blob.arrayBuffer()
  return { bytes: new Uint8Array(buf), mimeType: blob.type || mimeType }
}

interface ImageBitmapLike {
  width: number
  height: number
  close?(): void
}

async function decodeBitmap(bytes: Uint8Array, mimeType: string): Promise<ImageBitmapLike | null> {
  if (typeof createImageBitmap !== "function") return null
  try {
    const blob = new Blob([bytes as BlobPart], { type: mimeType })
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}

function closeBitmap(bitmap: ImageBitmapLike): void {
  if (typeof bitmap.close === "function") bitmap.close()
}

async function rasterToBlob(
  bitmap: ImageBitmapLike,
  width: number,
  height: number,
  mimeType: string
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext("2d") as
      | (CanvasRenderingContext2D & {
          drawImage: typeof CanvasRenderingContext2D.prototype.drawImage
        })
      | null
    if (!ctx) return null
    ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, width, height)
    try {
      return await canvas.convertToBlob({ type: mimeType })
    } catch {
      return null
    }
  }
  if (typeof document === "undefined") return null
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, width, height)
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), mimeType)
  })
}
