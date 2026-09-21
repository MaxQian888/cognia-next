/** Complete attachment PDF extraction over the shared page-wise OCR router. */
import { extractPdf as defaultExtractPdf, type PdfRouterDeps } from "@/lib/ocr/pdf-router"
import { createPdfLoader } from "@/lib/ocr/pdf-loader"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { getSettings } from "@/lib/db/settings"
import { DEFAULT_OCR_SETTINGS, type OcrPage, type OcrResult } from "@/types/ocr"
import type { PdfRouterInput } from "@/lib/ocr/pdf-router"

export const ATTACHMENT_OCR_MIN_TEXT_CHARS = 16

export interface AttachmentPdfExtractionProgress {
  totalPages: number
  processedPages: number
  page?: OcrPage
  error?: { pageNumber: number; message: string }
}

export interface AttachmentPdfExtractionOptions {
  signal?: AbortSignal
  onProgress?: (progress: AttachmentPdfExtractionProgress) => void
  /** Already extracted per-page layers; only substantive pages bypass OCR. */
  textPages?: Array<{ pageNumber: number; text: string }>
}

export interface AttachmentPdfOcrOutcome {
  text: string
  pages: OcrPage[]
  totalPages: number
  processedPages: number
  ocrPages: number
  status: "complete" | "partial" | "cancelled" | "failed"
  errors: Array<{ pageNumber?: number; message: string }>
  /** Compatibility field. Full extraction never caps trailing pages. */
  capped: false
}

export interface AttachmentPdfOcrDeps {
  extractPdf: (input: PdfRouterInput, deps: PdfRouterDeps) => Promise<OcrResult>
  buildPdfRouterDeps: () => PdfRouterDeps
  minTextChars?: number
}

/** Every page is attempted sequentially; failed pages remain explicit gaps. */
export async function extractAttachmentPdf(
  bytes: Uint8Array,
  options: AttachmentPdfExtractionOptions,
  deps: AttachmentPdfOcrDeps
): Promise<AttachmentPdfOcrOutcome> {
  let totalPages = 0
  let processedPages = 0
  const pages: OcrPage[] = []
  const errors: AttachmentPdfOcrOutcome["errors"] = []
  let cancelled = false
  let failed = false
  const threshold = deps.minTextChars ?? ATTACHMENT_OCR_MIN_TEXT_CHARS
  const knownPages = new Map((options.textPages ?? []).map((page) => [page.pageNumber, page]))
  try {
    options.signal?.throwIfAborted()
    const routerDeps = deps.buildPdfRouterDeps()
    const result = await deps.extractPdf(
      { bytes },
      {
        ...routerDeps,
        signal: options.signal,
        minTextLayerChars: threshold,
        continueOnPageError: true,
        onDocument: (count) => {
          totalPages = count
          options.onProgress?.({ totalPages, processedPages })
        },
        readPage: async (pageNumber) => {
          const known = knownPages.get(pageNumber)
          if (known && known.text.replace(/\s+/g, "").length >= threshold) {
            return { ...known, markdown: known.text, fromTextLayer: true }
          }
          return routerDeps.readPage?.(pageNumber) ?? null
        },
        onPage: (page, done, total) => {
          pages.push(page)
          processedPages = done
          totalPages = total
          options.onProgress?.({ totalPages, processedPages, page })
        },
        onPageError: (error, pageNumber, done, total) => {
          const failure = {
            pageNumber,
            message: error instanceof Error ? error.message : String(error),
          }
          errors.push(failure)
          processedPages = done
          totalPages = total
          options.onProgress?.({ totalPages, processedPages, error: failure })
        },
      }
    )
    // Custom adapters may return pages without streaming callbacks.
    if (pages.length === 0 && result.pages.length > 0) pages.push(...result.pages)
    if (totalPages === 0) totalPages = result.pages.length
    if (processedPages === 0) processedPages = result.pages.length
  } catch (error) {
    cancelled =
      options.signal?.aborted === true ||
      (error instanceof Error &&
        (error.name === "AbortError" || ("code" in error && error.code === "aborted")))
    if (!cancelled) {
      failed = true
      errors.push({ message: error instanceof Error ? error.message : String(error) })
    }
  }
  const text = pages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`).join("\n\n")
  const status = cancelled
    ? "cancelled"
    : failed || errors.length > 0
      ? pages.length > 0
        ? "partial"
        : "failed"
      : processedPages < totalPages
        ? "partial"
        : "complete"
  return {
    text,
    pages,
    totalPages,
    processedPages,
    ocrPages: pages.filter((page) => page.fromTextLayer === false).length,
    status,
    errors,
    capped: false,
  }
}

/** Compatibility facade: aggregate text cannot prove that every page has text. */
export async function maybeAttachmentPdfOcr(
  bytes: Uint8Array,
  _extractedText: string,
  deps: AttachmentPdfOcrDeps
): Promise<AttachmentPdfOcrOutcome | null> {
  const result = await extractAttachmentPdf(bytes, {}, deps)
  return result.pages.some((page) => page.text.trim()) ? result : null
}

export async function runAttachmentPdfExtraction(
  bytes: Uint8Array,
  options: AttachmentPdfExtractionOptions = {}
): Promise<AttachmentPdfOcrOutcome> {
  let settings = DEFAULT_OCR_SETTINGS
  try {
    settings = (await getSettings()).ocrSettings ?? DEFAULT_OCR_SETTINGS
  } catch {
    // Offline or locked settings use the existing local OCR defaults.
  }
  return extractAttachmentPdf(bytes, options, {
    extractPdf: defaultExtractPdf,
    buildPdfRouterDeps: () => ({
      loadPdf: createPdfLoader(),
      extractDeps: buildOcrDeps({ settings }),
      settings,
    }),
  })
}

/** Existing string-only callers receive an explicit partial-extraction notice. */
export async function runAttachmentPdfOcr(
  bytes: Uint8Array,
  _extractedText: string
): Promise<string | null> {
  const result = await runAttachmentPdfExtraction(bytes)
  if (!result.pages.some((page) => page.text.trim())) return null
  const notice =
    result.status === "complete"
      ? ""
      : `[PDF extraction ${result.status}: ${result.pages.length} of ${result.totalPages} pages available.]\n\n`
  return `${notice}${result.text}`
}
