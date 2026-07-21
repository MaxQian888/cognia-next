/**
 * OCR typed intermediate representation (ADR-0024 Phase 2 / IR).
 *
 * Inspired by Docling's `DoclingDocument` and Surya's per-block reading-order
 * model: a provider-agnostic document tree of ordered, typed blocks carrying
 * bbox + confidence + provenance. `markdown` / `text` / `blocks` outputs become
 * *pure serializers* of this tree (see `lib/ocr/document.ts`), so table-HTML,
 * formula-LaTeX, citation anchors, and the Live-Text overlay all read from one
 * structure regardless of which of the 20 providers produced it.
 *
 * Backward compatible: `OcrResult.document` is optional and additive; the
 * existing per-page `markdown`/`text` fields stay populated.
 */

/** Block roles in the document tree. Superset of `OcrBlockKind`. */
export type OcrDocumentBlockType =
  "heading" | "paragraph" | "list" | "table" | "figure" | "caption" | "formula" | "line" | "word"

/** A single ordered, typed block within a page. */
export interface OcrDocumentBlock {
  /**
   * Stable citation anchor `"<pageIndex>.<readingOrderIndex>"` (both 0-based).
   * An LLM can emit this id; `resolveCitation` maps it back to page + bbox so
   * the UI can highlight the source region.
   */
  id: string
  type: OcrDocumentBlockType
  /** Plain-text content (always populated). */
  text: string
  /** Table structure as HTML — preserves row/col spans Markdown can't. */
  html?: string
  /** Formula as LaTeX. */
  latex?: string
  /** Normalized bbox in page coordinates (px). Origin top-left. */
  bbox?: { x: number; y: number; width: number; height: number }
  /** 0..1 provider-native confidence. */
  confidence?: number
  /** 0-based reading order within the page. */
  readingOrderIndex: number
  /** Where this block came from. */
  provenance: { providerId: string; pageNumber: number }
}

/** A page of ordered blocks. */
export interface OcrDocumentPage {
  /** 1-based page number. */
  pageNumber: number
  /** Rasterized page width (px) when known. */
  width?: number
  /** Rasterized page height (px) when known. */
  height?: number
  /** Blocks in reading order. */
  blocks: OcrDocumentBlock[]
  /** True when the page came from the PDF text-layer fast-path, not OCR. */
  fromTextLayer?: boolean
}

/** The typed OCR document — the spine all serializers derive from. */
export interface OcrDocument {
  pages: OcrDocumentPage[]
}
