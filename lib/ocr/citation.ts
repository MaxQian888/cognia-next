/**
 * Citation anchors over the OCR typed IR (ADR-0024 Phase 2 / 2b).
 *
 * Each block carries a stable id `"<pageIndex>.<readingOrderIndex>"`. An LLM
 * answering from OCR'd text can cite a block by id; `resolveCitation` maps the
 * id back to a page + bbox so the UI can scroll to and highlight the exact
 * source region (the Live-Text overlay consumes the same bbox).
 */

import type { OcrDocument, OcrDocumentBlock } from "@/types/ocr"

/** Build the canonical citation id for a block position. */
export function citationId(pageIndex: number, readingOrderIndex: number): string {
  return `${pageIndex}.${readingOrderIndex}`
}

/** Find a block by its citation id. Null when the id isn't present. */
export function findBlock(doc: OcrDocument, id: string): OcrDocumentBlock | null {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.id === id) return block
    }
  }
  return null
}

export interface CitationLocation {
  pageNumber: number
  bbox?: OcrDocumentBlock["bbox"]
  text: string
}

/** Resolve a citation id to its page + bbox + text. Null when unknown. */
export function resolveCitation(doc: OcrDocument, id: string): CitationLocation | null {
  const block = findBlock(doc, id)
  if (!block) return null
  return { pageNumber: block.provenance.pageNumber, bbox: block.bbox, text: block.text }
}
