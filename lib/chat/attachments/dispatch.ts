/**
 * Attachment → {@link SendContentBlock} dispatch for the chat composer.
 *
 * This is the single place that turns a staged composer attachment into the
 * content block(s) we hand to the model. It deliberately reuses the existing,
 * production-wired subsystems rather than reimplementing any of them:
 *
 *   - image classification + downscale + base64 → `lib/ocr/image-prep`
 *   - PDF / docx / xlsx / pptx / csv / epub / md / code / html text extraction
 *     → `lib/document` (`processDocumentAsync`, browser-safe lazy parsers)
 *   - data-URL byte sizing → `lib/chat/draft-attachments`
 *
 * Routing:
 *   - images  → `image` block (downscaled when the long edge is large)
 *   - documents (any non-`unknown` {@link detectDocumentType}) → extracted text
 *     wrapped in a `text` block (kept as `type:'text'` so the connector PII
 *     gate `isPiiSafeSendContent` can scan it)
 *   - everything else → rejected with a machine-readable reason
 *
 * Emitting `text` (not base64 `document`) blocks for documents is intentional:
 * it supports far more formats than Anthropic's PDF-only `document` block, is
 * visible to the PII scanner, and matches how Twin ingest and the CLI already
 * handle attached files.
 */

import { decodeDataUrl, downscaleImage, bytesToBase64, isImageMimeType } from "@/lib/ocr/image-prep"
// Import the specific submodules (not the `@cognia/document` barrel) so the heavy
// pdfjs/mammoth/xlsx parsers stay lazily loaded — the same pattern the Twin
// uploader uses. `processDocumentAsync` dynamic-imports those internally.
import {
  detectDocumentType,
  processDocumentAsync,
  estimateTokenCount,
} from "@cognia/document/document-processor"
import { isBinaryDocumentType } from "@cognia/document/support-matrix"
import { detectLanguage } from "@cognia/document/parsers/code-parser"
import type { DocumentType } from "@/types/document"
import type { SendContent, SendContentBlock } from "@cognia/agent-config-types"

/**
 * The longest edge (px) we downscale large images to before base64-encoding.
 * Anthropic resamples anything beyond ~1568px on the long edge anyway, so this
 * trims upload + token cost with no quality loss the model would notice.
 */
export const IMAGE_MAX_LONG_EDGE = 1568

/**
 * Soft ceiling (in estimated tokens) for inlined document text. Above this the
 * composer asks the user to confirm before sending — we never silently truncate.
 * ~12k tokens ≈ a 50 KB text file.
 */
export const INLINE_TOKEN_CEILING = 12_000

/** A composer attachment staged for send. `url` is expected to be a data: URL. */
export interface SubmittedFile {
  url?: string
  mediaType?: string
  filename?: string
}

export type RejectReason = "not-data-url" | "unsupported-type" | "empty" | "parse-failed"

export interface AttachmentReject {
  filename: string
  reason: RejectReason
}

export interface DispatchResult {
  /** Attachment blocks (images first, then extracted-document text blocks). */
  blocks: SendContentBlock[]
  /** Files that could not be turned into a block, with the reason. */
  rejected: AttachmentReject[]
  /** Estimated inline token cost of the extracted-document text blocks. */
  tokens: number
}

export interface DispatchOptions {
  /** Override the image downscale long-edge (px). Defaults to {@link IMAGE_MAX_LONG_EDGE}. */
  imageMaxLongEdge?: number
  /**
   * OCR fallback for scanned / image-only PDFs whose text layer is empty or
   * sparse. Receives the raw PDF bytes plus whatever text the normal extraction
   * produced; returns OCR'd text to use instead, or `null` to keep the original
   * (which is then rejected as `"empty"`). Defaults to the client-side
   * `runAttachmentPdfOcr` (lazily imported so the OCR stack never enters the
   * eager chat bundle). Injected by tests to avoid loading real pdfjs/tesseract.
   */
  pdfOcrFallback?: (bytes: Uint8Array, extractedText: string) => Promise<string | null>
}

/**
 * Below this many non-whitespace chars a PDF's text layer is treated as scanned
 * → trigger the OCR fallback. Mirrors {@link ATTACHMENT_OCR_MIN_TEXT_CHARS}; kept
 * local so the heavy OCR stack stays lazily imported.
 */
export const PDF_OCR_TRIGGER_CHARS = 32

/** Lazy default: only pulls in the OCR stack when a sparse PDF is actually hit. */
async function defaultPdfOcrFallback(
  bytes: Uint8Array,
  extractedText: string
): Promise<string | null> {
  const { runAttachmentPdfOcr } = await import("./pdf-ocr-fallback")
  return runAttachmentPdfOcr(bytes, extractedText)
}

/** Document types whose extracted text reads best inside a fenced code block. */
const FENCED_TYPES: ReadonlySet<DocumentType> = new Set(["code", "json", "markdown", "html", "csv"])

function fenceLanguage(type: DocumentType, filename: string): string {
  if (type === "code") return detectLanguage(filename)
  if (type === "json") return "json"
  if (type === "markdown") return "markdown"
  if (type === "html") return "html"
  return ""
}

/**
 * Wrap a document's extracted text in a `text` block with a filename header so
 * the model knows the provenance of the content. Code-ish types get a fence.
 */
export function formatDocumentText(type: DocumentType, filename: string, content: string): string {
  const header = `Attached file "${filename}":`
  if (FENCED_TYPES.has(type)) {
    const lang = fenceLanguage(type, filename)
    return `${header}\n\n\`\`\`${lang}\n${content}\n\`\`\``
  }
  return `${header}\n\n${content}`
}

async function imageBlock(
  bytes: Uint8Array,
  mediaType: string,
  maxLongEdge: number
): Promise<SendContentBlock> {
  const scaled = await downscaleImage(bytes, mediaType, maxLongEdge)
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: scaled.mimeType,
      data: bytesToBase64(scaled.bytes),
    },
  }
}

async function documentTextBlock(
  type: DocumentType,
  filename: string,
  bytes: Uint8Array,
  id: string,
  pdfOcrFallback: (bytes: Uint8Array, extractedText: string) => Promise<string | null>
): Promise<SendContentBlock | null> {
  // Binary formats need the raw ArrayBuffer; text formats decode to a string so
  // processDocumentAsync takes its sync fast-path.
  const data: string | ArrayBuffer = isBinaryDocumentType(type)
    ? toArrayBuffer(bytes)
    : new TextDecoder().decode(bytes)
  const processed = await processDocumentAsync(id, filename, data, {
    extractEmbeddable: true,
  })
  let text = (processed.embeddableContent || processed.content || "").trim()

  // Scanned / image-only PDFs yield an empty (or page-number-only) text layer.
  // Re-run them through the client-side OCR fallback before giving up.
  if (type === "pdf" && nonWhitespaceLength(text) < PDF_OCR_TRIGGER_CHARS) {
    const ocrText = (await pdfOcrFallback(bytes, text))?.trim()
    if (ocrText) text = ocrText
  }

  if (!text) return null
  return { type: "text", text: formatDocumentText(type, filename, text) }
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy into a standalone ArrayBuffer so we never hand a SharedArrayBuffer /
  // view-with-offset to the parsers.
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

/**
 * Convert a list of staged attachments into content blocks. Images are
 * downscaled + base64-encoded; documents are text-extracted via `lib/document`.
 * Returns the produced blocks plus the list of files that were rejected.
 */
export async function buildAttachmentBlocks(
  files: readonly SubmittedFile[],
  options: DispatchOptions = {}
): Promise<DispatchResult> {
  const maxLongEdge = options.imageMaxLongEdge ?? IMAGE_MAX_LONG_EDGE
  const pdfOcrFallback = options.pdfOcrFallback ?? defaultPdfOcrFallback
  const images: SendContentBlock[] = []
  const docs: SendContentBlock[] = []
  const rejected: AttachmentReject[] = []

  let index = 0
  for (const f of files) {
    const filename = f.filename ?? "attachment"
    const url = f.url ?? ""
    const decoded = url.startsWith("data:") ? decodeDataUrl(url) : null
    if (!decoded) {
      rejected.push({ filename, reason: "not-data-url" })
      continue
    }
    const mediaType = f.mediaType || decoded.mimeType

    if (mediaType.startsWith("image/") || isImageMimeType(mediaType)) {
      images.push(await imageBlock(decoded.bytes, mediaType, maxLongEdge))
      index++
      continue
    }

    const type = detectDocumentType(filename)
    if (type === "unknown") {
      rejected.push({ filename, reason: "unsupported-type" })
      continue
    }

    try {
      const block = await documentTextBlock(
        type,
        filename,
        decoded.bytes,
        `att-${index}`,
        pdfOcrFallback
      )
      if (block) {
        docs.push(block)
      } else {
        rejected.push({ filename, reason: "empty" })
      }
    } catch {
      rejected.push({ filename, reason: "parse-failed" })
    }
    index++
  }

  const tokens = docs.reduce(
    (sum, b) => sum + (b.type === "text" ? estimateTokenCount(b.text) : 0),
    0
  )
  return { blocks: [...images, ...docs], rejected, tokens }
}

/**
 * Build the final {@link SendContent} for a user turn: attachment blocks first,
 * then the trimmed user text. Falls back to a plain string when there are no
 * attachment blocks (keeps single-text turns wire-compatible with the old path).
 */
export async function buildSendContent(
  text: string,
  files: readonly SubmittedFile[],
  options: DispatchOptions = {}
): Promise<{ content: SendContent; rejected: AttachmentReject[]; tokens: number }> {
  const trimmed = text.trim()
  const { blocks, rejected, tokens } = await buildAttachmentBlocks(files, options)

  if (blocks.length === 0) {
    return { content: trimmed, rejected, tokens }
  }
  const out: SendContentBlock[] = [...blocks]
  if (trimmed) out.push({ type: "text", text: trimmed })
  return { content: out, rejected, tokens }
}

/** Estimate the inline token cost of a document's extracted text. */
export function estimateDocumentTokens(content: string): number {
  return estimateTokenCount(content)
}
