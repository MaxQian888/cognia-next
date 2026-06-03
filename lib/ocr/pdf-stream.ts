/**
 * Streaming / resumable large-PDF OCR (ADR-0024 Phase 2 / 2e).
 *
 * Thin wrapper over `extractPdf` that wires the per-page cache
 * (`readCachedPage`/`writeCachedPage`) and surfaces an `onPage` progress
 * callback. Because each page is cached as it completes, a re-run with the same
 * `fileSha` + provider + languages resumes past whatever already landed — a
 * crash, cancel, or reload mid-document costs only the unfinished pages. No new
 * scheduler: the loop is self-contained and `signal` cancels between pages.
 */

import { extractPdf, type PdfRouterDeps, type PdfRouterInput } from "./pdf-router"
import { readCachedPage, writeCachedPage } from "./cache"
import type { OcrPage, OcrResult } from "@/types/ocr"

export interface PdfStreamInput extends PdfRouterInput {
  /** File SHA — the per-page cache key. Omit to disable caching/resume. */
  fileSha?: string
  /** Provider id for the cache key. Defaults to the router's `ocrProviderId`. */
  providerId?: string
}

export interface PdfStreamOptions {
  /** Fired after each page lands (cached or freshly produced). */
  onPage?: (page: OcrPage, doneCount: number, total: number) => void
  /** Abort between pages. */
  signal?: AbortSignal
  /** Disable the per-page cache (e.g. probes). Default on when `fileSha` is set. */
  useCache?: boolean
}

export async function extractPdfStreaming(
  input: PdfStreamInput,
  deps: PdfRouterDeps,
  opts: PdfStreamOptions = {}
): Promise<OcrResult> {
  const useCache = opts.useCache !== false && typeof input.fileSha === "string"
  const providerId = input.providerId ?? deps.ocrProviderId ?? "pdf-router"
  const languages = input.languages ?? deps.extractDeps.settings.defaultLanguages
  const keyFor = (pageNumber: number) => ({
    fileSha: input.fileSha as string,
    providerId,
    languages,
    pageNumber,
  })
  return extractPdf(input, {
    ...deps,
    onPage: opts.onPage,
    signal: opts.signal,
    readPage: useCache ? (n) => readCachedPage(keyFor(n)) : undefined,
    writePage: useCache ? (n, page) => writeCachedPage(keyFor(n), page) : undefined,
  })
}
