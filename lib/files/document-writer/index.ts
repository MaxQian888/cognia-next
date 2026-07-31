// Client-side document writer — turns markdown / plain-text content into a
// downloadable Word (.docx) or PDF file, entirely in the webview (no server, no
// sidecar). Built for the standalone mobile app's "download as Word/PDF" flow,
// but shell-agnostic. The heavy `docx` / `jspdf` libraries are lazy-imported so
// they never enter the main bundle; saving reuses the cross-platform
// `saveExport` (Capacitor filesystem / Tauri dialog / web download).

import { saveExport, type SaveExportOutcome } from "@/lib/files/save-export"

import { parseMarkdownBlocks, type DocBlock } from "./blocks"

export type DocFormat = "docx" | "pdf"

export interface GeneratedDocument {
  data: Blob
  mimeType: string
  filename: string
}

const MIME: Record<DocFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
}

/** Strip characters a filename can't carry, keeping the title readable. */
function safeFilename(title: string, format: DocFormat): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "document"
  return `${base}.${format}`
}

/** Render parsed blocks into a .docx Blob via the `docx` library. */
async function renderDocx(blocks: DocBlock[]): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx")
  const headingFor = (level: 1 | 2 | 3) =>
    level === 1
      ? HeadingLevel.HEADING_1
      : level === 2
        ? HeadingLevel.HEADING_2
        : HeadingLevel.HEADING_3

  const paragraphs = blocks.map((b) => {
    switch (b.kind) {
      case "heading":
        return new Paragraph({ heading: headingFor(b.level), children: [new TextRun(b.text)] })
      case "listItem":
        return new Paragraph({ text: b.text, bullet: { level: 0 } })
      case "code":
        return new Paragraph({ children: [new TextRun({ text: b.text, font: "Courier New" })] })
      case "paragraph":
      default:
        return new Paragraph({ children: [new TextRun(b.text)] })
    }
  })

  const doc = new Document({ sections: [{ children: paragraphs }] })
  return Packer.toBlob(doc)
}

/** Render parsed blocks into a PDF Blob via `jspdf`. */
async function renderPdf(blocks: DocBlock[]): Promise<Blob> {
  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const margin = 48
  const pageHeight = doc.internal.pageSize.getHeight()
  const maxWidth = doc.internal.pageSize.getWidth() - margin * 2
  let y = margin

  const writeLines = (text: string, size: number, gap: number) => {
    doc.setFontSize(size)
    for (const line of doc.splitTextToSize(text, maxWidth) as string[]) {
      if (y + size > pageHeight - margin) {
        doc.addPage()
        y = margin
      }
      doc.text(line, margin, y)
      y += size + 2
    }
    y += gap
  }

  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        writeLines(b.text, b.level === 1 ? 20 : b.level === 2 ? 16 : 14, 6)
        break
      case "listItem":
        writeLines(`• ${b.text}`, 11, 2)
        break
      case "code":
        doc.setFont("courier", "normal")
        writeLines(b.text, 10, 6)
        doc.setFont("helvetica", "normal")
        break
      case "paragraph":
      default:
        writeLines(b.text, 11, 6)
        break
    }
  }

  return doc.output("blob")
}

/** Generate a document Blob (+ filename + mime) from markdown content. */
export async function generateDocument(opts: {
  title: string
  markdown: string
  format: DocFormat
}): Promise<GeneratedDocument> {
  const blocks = parseMarkdownBlocks(opts.markdown)
  const data = opts.format === "docx" ? await renderDocx(blocks) : await renderPdf(blocks)
  return { data, mimeType: MIME[opts.format], filename: safeFilename(opts.title, opts.format) }
}

/** Generate and save a document to the device, returning where it landed. */
export async function saveGeneratedDocument(opts: {
  title: string
  markdown: string
  format: DocFormat
}): Promise<SaveExportOutcome> {
  const doc = await generateDocument(opts)
  return saveExport({ filename: doc.filename, data: doc.data, mimeType: doc.mimeType })
}
