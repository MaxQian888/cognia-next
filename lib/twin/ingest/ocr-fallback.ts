/**
 * OCR fallback for the twin ingest parse stage (ADR-0024).
 *
 * `lib/document/parsers/pdf-parser.ts` extracts only a PDF's text layer, so a
 * scanned / image-only PDF yields (near-)empty text and silently produces no
 * embeddings. When the parsed text is below a small threshold we re-run the
 * document through `lib/ocr/pdf-router.ts:extractPdf`, whose own per-page
 * text-layer fast-path keeps digital PDFs free and only OCRs the empty pages.
 *
 * The OCR'd text then flows through the unchanged redact → chunk → embed →
 * persist chain (the existing PII redaction gate applies automatically).
 * Best-effort: any failure falls back to whatever the text layer produced.
 */

import { extractPdf as defaultExtractPdf, type PdfRouterDeps } from "@/lib/ocr/pdf-router"
import { createPdfLoader } from "@/lib/ocr/pdf-loader"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { getSettings } from "@/lib/db/settings"
import { DEFAULT_OCR_SETTINGS, type OcrResult } from "@/types/ocr"
import type { PdfRouterInput } from "@/lib/ocr/pdf-router"
import type { ParsedSource, RawSource } from "./parse"

/** Below this many non-whitespace chars a PDF is treated as scanned → OCR. */
export const TWIN_OCR_MIN_TEXT_CHARS = 32

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length
}

export interface TwinOcrFallbackDeps {
  extractPdf: (input: PdfRouterInput, deps: PdfRouterDeps) => Promise<OcrResult>
  /** Build the per-document router deps (loader + extract deps). */
  buildPdfRouterDeps: () => PdfRouterDeps
  /** Override the low-text threshold (tests). */
  minTextChars?: number
}

/**
 * Returns OCR'd text to use in place of the parsed text, or null to keep the
 * text layer. Only fires for low-text PDF binaries. Pure w.r.t. injected deps.
 */
export async function maybeTwinPdfOcr(
  raw: RawSource,
  parsed: ParsedSource,
  deps: TwinOcrFallbackDeps
): Promise<string | null> {
  if (raw.format !== "pdf" || !raw.binary) return null
  const threshold = deps.minTextChars ?? TWIN_OCR_MIN_TEXT_CHARS
  if (nonWhitespaceLength(parsed.embeddableText) >= threshold) return null
  const bytes = raw.binary instanceof Uint8Array ? raw.binary : new Uint8Array(raw.binary)
  try {
    const result = await deps.extractPdf({ bytes }, deps.buildPdfRouterDeps())
    const text = result.combinedText.trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * Production wrapper: load OCR settings, build the real router deps (pdfjs
 * loader + keyring-backed extract deps), and run the PDF OCR fallback.
 */
export async function runTwinPdfOcr(raw: RawSource, parsed: ParsedSource): Promise<string | null> {
  let settings = DEFAULT_OCR_SETTINGS
  try {
    settings = (await getSettings()).ocrSettings ?? DEFAULT_OCR_SETTINGS
  } catch {
    // Dexie unavailable — fall back to defaults.
  }
  const extractDeps = buildOcrDeps({ settings })
  return maybeTwinPdfOcr(raw, parsed, {
    extractPdf: defaultExtractPdf,
    buildPdfRouterDeps: () => ({ loadPdf: createPdfLoader(), extractDeps, settings }),
  })
}
