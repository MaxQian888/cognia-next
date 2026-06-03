/**
 * OCR typed-IR construction + serialization (ADR-0024 Phase 2).
 *
 * `buildOcrDocument` synthesizes an {@link OcrDocument} from the per-page
 * provider output (`OcrPage[]`), assigning a stable reading order and citation
 * id to every block. The `documentTo*` functions are *pure serializers* of that
 * tree — the single place `markdown` / `text` / `blocks` are derived, so every
 * provider flows through identical assembly.
 */

import type {
  OcrBlock,
  OcrBlockKind,
  OcrDocument,
  OcrDocumentBlock,
  OcrDocumentBlockType,
  OcrDocumentPage,
  OcrPage,
} from "@/types/ocr"

function mapKind(kind: OcrBlockKind | undefined): OcrDocumentBlockType {
  switch (kind) {
    case "line":
      return "line"
    case "word":
      return "word"
    case "table":
      return "table"
    case "formula":
      return "formula"
    case "paragraph":
    default:
      return "paragraph"
  }
}

/**
 * Order blocks for reading. When every block has a bbox we sort top-to-bottom
 * then left-to-right with a row-tolerance band (so words on the same visual
 * line keep left→right order despite small y jitter). Without bboxes we keep
 * the provider's original order. Returns blocks paired with their 0-based index.
 */
export function orderBlocksForReading(blocks: OcrBlock[]): OcrBlock[] {
  if (blocks.length <= 1) return [...blocks]
  const allHaveBbox = blocks.every((b) => b.bbox !== undefined)
  if (!allHaveBbox) return [...blocks]
  const heights = blocks.map((b) => b.bbox!.height).filter((h) => h > 0)
  const medianHeight =
    heights.length > 0 ? [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)]! : 0
  const tolerance = medianHeight * 0.5
  return [...blocks].sort((a, b) => {
    const ay = a.bbox!.y
    const by = b.bbox!.y
    if (Math.abs(ay - by) > tolerance) return ay - by
    return a.bbox!.x - b.bbox!.x
  })
}

/** Build the typed document IR from per-page provider output. */
export function buildOcrDocument(pages: OcrPage[], providerId: string): OcrDocument {
  const docPages: OcrDocumentPage[] = pages.map((page, pageIndex) => {
    const provenance = { providerId, pageNumber: page.pageNumber }
    let blocks: OcrDocumentBlock[]
    if (page.blocks && page.blocks.length > 0) {
      blocks = orderBlocksForReading(page.blocks).map((b, roi) => ({
        id: `${pageIndex}.${roi}`,
        type: mapKind(b.kind),
        text: b.text,
        bbox: b.bbox,
        confidence: b.confidence,
        readingOrderIndex: roi,
        provenance,
      }))
    } else if (page.text.trim().length > 0) {
      // No structured blocks — represent the page as a single paragraph so the
      // IR stays uniform and serializers round-trip the text.
      blocks = [
        {
          id: `${pageIndex}.0`,
          type: "paragraph",
          text: page.text,
          readingOrderIndex: 0,
          provenance,
        },
      ]
    } else {
      blocks = []
    }
    return {
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      blocks,
      fromTextLayer: page.fromTextLayer,
    }
  })
  return { pages: docPages }
}

function blockToMarkdown(block: OcrDocumentBlock): string {
  switch (block.type) {
    case "heading":
      return `## ${block.text}`
    case "list":
      return `- ${block.text}`
    case "caption":
      return `*${block.text}*`
    case "table":
      return block.html ? block.html : block.text
    case "formula":
      return block.latex ? `$$\n${block.latex}\n$$` : block.text
    default:
      return block.text
  }
}

function pageToText(page: OcrDocumentPage): string {
  return page.blocks.map((b) => b.text).join("\n")
}

function pageToMarkdown(page: OcrDocumentPage): string {
  return page.blocks.map(blockToMarkdown).join("\n\n")
}

/** Concatenated plain text (pages newline-separated). Mirrors `combinePageText`. */
export function documentToText(doc: OcrDocument): string {
  return doc.pages.map(pageToText).join("\n\n")
}

/** Concatenated Markdown with per-page dividers. Mirrors `combinePageMarkdown`. */
export function documentToMarkdown(doc: OcrDocument): string {
  if (doc.pages.length === 0) return ""
  if (doc.pages.length === 1) return pageToMarkdown(doc.pages[0]!)
  return doc.pages
    .map((p) => `<!-- page ${p.pageNumber} -->\n${pageToMarkdown(p)}`)
    .join("\n\n---\n\n")
}

/** Flatten the IR back to the legacy `OcrBlock[]` shape. */
export function documentToBlocks(doc: OcrDocument): OcrBlock[] {
  const out: OcrBlock[] = []
  const KEEP: ReadonlySet<OcrDocumentBlockType> = new Set<OcrDocumentBlockType>([
    "line",
    "word",
    "table",
    "formula",
  ])
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      out.push({
        text: block.text,
        bbox: block.bbox,
        confidence: block.confidence,
        kind: KEEP.has(block.type) ? (block.type as OcrBlockKind) : "paragraph",
      })
    }
  }
  return out
}
