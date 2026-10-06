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
import { buildDocumentStructure } from "@cognia/document/document-structure"
import type { DocumentPageRange } from "@cognia/document/types"
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
export async function maybeTwinPdfOcrWithProvenance(
  raw: RawSource,
  parsed: ParsedSource,
  deps: TwinOcrFallbackDeps
): Promise<Pick<ParsedSource, "originalText" | "embeddableText" | "pageMap" | "structure"> | null> {
  if (raw.format !== "pdf" || !raw.binary) return null
  const threshold = deps.minTextChars ?? TWIN_OCR_MIN_TEXT_CHARS
  const sparsePage = parsed.structure?.pages.some(
    (page) => nonWhitespaceLength(parsed.originalText.slice(page.charStart, page.charEnd)) < 16
  )
  if (!sparsePage && nonWhitespaceLength(parsed.originalText) >= threshold) return null
  const bytes = raw.binary instanceof Uint8Array ? raw.binary : new Uint8Array(raw.binary)
  try {
    const result = await deps.extractPdf({ bytes }, deps.buildPdfRouterDeps())
    const text = result.pages.length
      ? result.pages.map((page) => page.text).join("\n\n")
      : result.combinedText
    if (!text.trim()) return null
    let cursor = 0
    const pages: DocumentPageRange[] = result.pages.map((page) => {
      const charStart = cursor
      const charEnd = cursor + page.text.length
      cursor = charEnd + 2
      return {
        pageNumber: page.pageNumber,
        charStart,
        charEnd,
        lineStart: text.slice(0, charStart).split("\n").length,
        lineEnd: text.slice(0, Math.max(charStart, charEnd - 1)).split("\n").length,
        provenance: page.fromTextLayer ? "text-layer" : "ocr",
        ...(page.fromTextLayer &&
        parsed.pageMap?.find((entry) => entry.pageNumber === page.pageNumber)?.bboxUnion
          ? {
              bboxUnion: parsed.pageMap.find((entry) => entry.pageNumber === page.pageNumber)!
                .bboxUnion,
            }
          : {}),
      }
    })
    // Preserve bookmarks by mapping their source page into the new canonical text.
    const outlineNodes = parsed.structure?.nodes ?? []
    const outlineChildren = (parentId: string): import("@cognia/document/types").PDFOutlineItem[] =>
      outlineNodes
        .filter((node) => node.parentId === parentId)
        .map((node) => ({
          title: node.title,
          pageNumber: node.pageStart,
          children: outlineChildren(node.id),
        }))
    const outline = outlineChildren("root")
    const structure = buildDocumentStructure({
      content: text,
      title: parsed.title,
      pages,
      ...(outline?.length
        ? { pdf: { text, pages: [], pageCount: pages.length, metadata: {}, outline } }
        : {}),
    })
    return {
      originalText: text,
      embeddableText: text,
      pageMap: pages.map(({ pageNumber, charStart, charEnd, bboxUnion }) => ({
        pageNumber,
        charStart,
        charEnd,
        ...(bboxUnion ? { bboxUnion } : {}),
      })),
      structure,
    }
  } catch {
    return null
  }
}

/**
 * Production wrapper: load OCR settings, build the real router deps (pdfjs
 * loader + keyring-backed extract deps), and run the PDF OCR fallback.
 */
export async function runTwinPdfOcrWithProvenance(
  raw: RawSource,
  parsed: ParsedSource
): ReturnType<typeof maybeTwinPdfOcrWithProvenance> {
  let settings = DEFAULT_OCR_SETTINGS
  try {
    settings = (await getSettings()).ocrSettings ?? DEFAULT_OCR_SETTINGS
  } catch {
    // Dexie unavailable — fall back to defaults.
  }
  const extractDeps = buildOcrDeps({ settings })
  return maybeTwinPdfOcrWithProvenance(raw, parsed, {
    extractPdf: defaultExtractPdf,
    buildPdfRouterDeps: () => ({ loadPdf: createPdfLoader(), extractDeps, settings }),
  })
}

/** Legacy text-only facade for callers that do not persist source provenance. */
export async function maybeTwinPdfOcr(
  raw: RawSource,
  parsed: ParsedSource,
  deps: TwinOcrFallbackDeps
): Promise<string | null> {
  return (await maybeTwinPdfOcrWithProvenance(raw, parsed, deps))?.originalText ?? null
}

export async function runTwinPdfOcr(raw: RawSource, parsed: ParsedSource): Promise<string | null> {
  return (await runTwinPdfOcrWithProvenance(raw, parsed))?.originalText ?? null
}
