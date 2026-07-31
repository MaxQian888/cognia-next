/**
 * OCR fallback for chat-composer PDF attachments (ADR-0024, P4).
 *
 * `processDocumentAsync` (lib/document) extracts only a PDF's text layer, so a
 * scanned / image-only PDF yields (near-)empty text and the composer rejects the
 * file as `"empty"`. When the extracted text is below a small threshold we re-run
 * the document through `lib/ocr/pdf-router.ts:extractPdf`, whose own per-page
 * text-layer fast-path keeps digital pages free and only rasterizes + OCRs the
 * empty ones. The chosen OCR provider is the auto-router's local engine
 * (`tesseract-wasm` in the browser/Capacitor shells), so this works entirely
 * client-side with no sidecar.
 *
 * This deliberately reuses the exact same building blocks the twin ingest OCR
 * fallback (`lib/twin/ingest/ocr-fallback.ts`) uses — `extractPdf`,
 * `createPdfLoader`, `buildOcrDeps` — rather than reimplementing PDF rasterizing
 * or worker management.
 *
 * Guards:
 *   - Very large PDFs are capped at {@link ATTACHMENT_OCR_MAX_PAGES} pages. The
 *     cap is never silent: it is logged AND surfaced as a leading note in the
 *     returned text so neither the user nor the model is misled.
 *   - Any OCR failure resolves to `null` so the caller falls back to its
 *     existing `"empty"` / `"parse-failed"` rejection.
 */

import { extractPdf as defaultExtractPdf, type PdfRouterDeps } from "@/lib/ocr/pdf-router"
import { createPdfLoader } from "@/lib/ocr/pdf-loader"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { getSettings } from "@/lib/db/settings"
import { DEFAULT_OCR_SETTINGS, type OcrResult } from "@/types/ocr"
import type { PdfRouterInput } from "@/lib/ocr/pdf-router"
import { loggers } from "@cognia/logging"

/** Below this many non-whitespace chars a PDF is treated as scanned → OCR. */
export const ATTACHMENT_OCR_MIN_TEXT_CHARS = 32

/**
 * Hard cap on the number of pages we rasterize + OCR for a single attachment.
 * OCR is expensive (one WASM recognize pass per page); 20 pages keeps a
 * worst-case scan bounded while covering the overwhelming majority of attached
 * documents. Pages beyond the cap are skipped — and the skip is surfaced, never
 * silent (see module docs).
 */
export const ATTACHMENT_OCR_MAX_PAGES = 20

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length
}

/** Outcome of an OCR fallback attempt. `null` means "keep the original path". */
export interface AttachmentPdfOcrOutcome {
  /** OCR'd text to use in place of the (empty) extracted text. */
  text: string
  /** Total page count reported by the PDF document. */
  totalPages: number
  /** Number of pages actually rasterized + OCR'd (≤ totalPages and ≤ cap). */
  ocrPages: number
  /** True when `totalPages > cap` and trailing pages were skipped. */
  capped: boolean
}

export interface AttachmentPdfOcrDeps {
  /** Single-document PDF extraction (text-layer fast-path + per-page OCR). */
  extractPdf: (input: PdfRouterInput, deps: PdfRouterDeps) => Promise<OcrResult>
  /** Build the per-document router deps (loader + extract deps). */
  buildPdfRouterDeps: () => PdfRouterDeps
  /** Override the low-text threshold (tests). */
  minTextChars?: number
  /** Override the page cap (tests). */
  maxPages?: number
  /** Logger seam — receives the "pages capped" warning. Defaults to the media logger. */
  log?: (message: string, data?: Record<string, unknown>) => void
}

/**
 * Returns the OCR outcome to use in place of the empty/sparse extracted text,
 * or `null` to keep whatever the text layer produced (or to reject). Pure with
 * respect to the injected deps so unit tests need no real pdfjs/tesseract.
 *
 * @param bytes         Raw PDF bytes.
 * @param extractedText Text the normal extraction produced (may be empty).
 */
export async function maybeAttachmentPdfOcr(
  bytes: Uint8Array,
  extractedText: string,
  deps: AttachmentPdfOcrDeps
): Promise<AttachmentPdfOcrOutcome | null> {
  const threshold = deps.minTextChars ?? ATTACHMENT_OCR_MIN_TEXT_CHARS
  if (nonWhitespaceLength(extractedText) >= threshold) return null
  const maxPages = deps.maxPages ?? ATTACHMENT_OCR_MAX_PAGES
  const log = deps.log ?? ((message, data) => loggers.media.warn(message, data))

  const routerDeps = deps.buildPdfRouterDeps()
  try {
    // Pre-count pages so the cap can be applied (and reported) instead of
    // silently truncating downstream. A lightweight getDocument relative to the
    // per-page raster + OCR work that follows.
    const doc = await routerDeps.loadPdf({ bytes })
    const totalPages = Math.max(0, doc.numPages)
    if (totalPages === 0) return null

    const capped = totalPages > maxPages
    const ocrPages = capped ? maxPages : totalPages
    const input: PdfRouterInput = capped ? { bytes, pageRange: `1-${maxPages}` } : { bytes }
    if (capped) {
      log(`PDF attachment OCR capped to the first ${maxPages} of ${totalPages} pages`, {
        totalPages,
        maxPages,
      })
    }

    const result = await deps.extractPdf(input, routerDeps)
    const ocrText = result.combinedText.trim()
    if (!ocrText) return null

    const text = capped
      ? `[OCR processed the first ${maxPages} of ${totalPages} pages; later pages were skipped.]\n\n${ocrText}`
      : ocrText
    return { text, totalPages, ocrPages, capped }
  } catch {
    // Best-effort: any loader / OCR failure falls back to the caller's rejection.
    return null
  }
}

/**
 * Production wrapper: load OCR settings, build the real router deps (pdfjs
 * loader + keyring-backed extract deps), run the PDF OCR fallback, and return
 * just the text (or `null`). The page-cap note, when present, is embedded in the
 * returned text.
 */
export async function runAttachmentPdfOcr(
  bytes: Uint8Array,
  extractedText: string
): Promise<string | null> {
  let settings = DEFAULT_OCR_SETTINGS
  try {
    settings = (await getSettings()).ocrSettings ?? DEFAULT_OCR_SETTINGS
  } catch {
    // Dexie unavailable — fall back to defaults.
  }
  const extractDeps = buildOcrDeps({ settings })
  const outcome = await maybeAttachmentPdfOcr(bytes, extractedText, {
    extractPdf: defaultExtractPdf,
    buildPdfRouterDeps: () => ({ loadPdf: createPdfLoader(), extractDeps, settings }),
  })
  return outcome ? outcome.text : null
}
