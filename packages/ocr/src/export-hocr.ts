/**
 * hOCR export from the OCR typed IR (ADR-0024 Phase 2 / 2g).
 *
 * hOCR is an XHTML microformat (the de-facto interchange format consumed by
 * Tesseract tooling, OCR-D, archival pipelines, and browser viewers) that
 * embeds bbox + confidence in `title` attributes. This is an **export-only**
 * adapter — the internal SoT stays the typed `OcrDocument`; we never parse
 * hOCR back. Pure function, no DOM.
 *
 * Block-type mapping: heading/paragraph/caption/list → `ocr_par`, line → `ocr_line`,
 * word → `ocrx_word`, table/figure/formula → `ocr_par` carrying the text (the
 * structured html/latex lives in the IR, not hOCR).
 */

import type { OcrDocument, OcrDocumentBlock, OcrDocumentPage } from "./types"

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** hOCR `bbox x0 y0 x1 y1` from a block bbox. */
function bboxTitle(block: OcrDocumentBlock): string {
  const b = block.bbox
  if (!b) return ""
  const x0 = Math.round(b.x)
  const y0 = Math.round(b.y)
  const x1 = Math.round(b.x + b.width)
  const y1 = Math.round(b.y + b.height)
  return `bbox ${x0} ${y0} ${x1} ${y1}`
}

function wordConf(block: OcrDocumentBlock): string {
  if (typeof block.confidence !== "number") return ""
  return `; x_wconf ${Math.round(block.confidence * 100)}`
}

function blockTag(block: OcrDocumentBlock): { tag: string; cls: string } {
  switch (block.type) {
    case "line":
      return { tag: "span", cls: "ocr_line" }
    case "word":
      return { tag: "span", cls: "ocrx_word" }
    default:
      return { tag: "p", cls: "ocr_par" }
  }
}

function renderBlock(block: OcrDocumentBlock): string {
  const { tag, cls } = blockTag(block)
  const title = `${bboxTitle(block)}${wordConf(block)}`.trim()
  const titleAttr = title ? ` title="${title}"` : ""
  return `      <${tag} class="${cls}" id="block_${block.id.replace(".", "_")}"${titleAttr}>${escapeHtml(block.text)}</${tag}>`
}

function renderPage(page: OcrDocumentPage, pageIndex: number): string {
  const dims =
    page.width && page.height
      ? ` bbox 0 0 ${Math.round(page.width)} ${Math.round(page.height)}`
      : ""
  const title = `image "";${dims ? dims : " bbox 0 0 0 0"}; ppageno ${pageIndex}`
  const blocks = page.blocks.map(renderBlock).join("\n")
  return `    <div class="ocr_page" id="page_${pageIndex}" title='${title}'>\n${blocks}\n    </div>`
}

/** Serialize the typed document to an hOCR XHTML string. */
export function documentToHocr(doc: OcrDocument): string {
  const pages = doc.pages.map((p, i) => renderPage(p, i)).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta name="ocr-system" content="cognia-ocr" />
    <meta name="ocr-capabilities" content="ocr_page ocr_par ocr_line ocrx_word" />
  </head>
  <body>
${pages}
  </body>
</html>`
}
