/**
 * PDF Parser - Extract text content from PDF files
 * Uses pdf.js (pdfjs-dist) for parsing
 * Enhanced with layout-aware extraction, password support, outline & annotation extraction
 */

import { isTauri } from "../runtime-adapters"
import type { ParseDiagnostic, PdfTextItem } from "../types"

export type { PdfTextItem }

/** Below this many trimmed chars the text layer is considered sparse
 *  (mirrors the 16-char heuristic in `lib/ocr/pdf-router`). */
const SPARSE_TEXT_THRESHOLD = 16

export interface PDFParseResult {
  text: string
  pageCount: number
  pages: PDFPage[]
  metadata: PDFMetadata
  outline?: PDFOutlineItem[]
  annotations?: PDFAnnotation[]
  /** Parser-level diagnostics (e.g. native-parse fallback) merged into
   *  `ProcessedDocument.parseDiagnostics` by the document processor. */
  diagnostics?: ParseDiagnostic[]
}

export interface PDFPage {
  pageNumber: number
  text: string
  width: number
  height: number
  /** Spatial text items — only present on the native (Tauri liteparse) path. */
  items?: PdfTextItem[]
  /** True when the per-page/document item cap dropped this page's items. */
  itemsTruncated?: boolean
}

export interface PDFMetadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
  producer?: string
  creationDate?: Date
  modificationDate?: Date
}

export interface PDFParseOptions {
  password?: string
  startPage?: number
  endPage?: number
  extractOutline?: boolean
  extractAnnotations?: boolean
}

export interface PDFOutlineItem {
  title: string
  pageNumber?: number
  children: PDFOutlineItem[]
}

export interface PDFAnnotation {
  type: string
  content: string
  pageNumber: number
  rect?: { x: number; y: number; width: number; height: number }
}

/**
 * Parse PDF from ArrayBuffer.
 *
 * Desktop (Tauri) tries the native liteparse backend first — it adds
 * per-item bounding boxes (`PDFPage.items`) the pdfjs path cannot produce.
 * ANY native failure falls through to the unchanged pdfjs path below, so
 * parsing never fails because the native path failed. The fallback lives
 * here because `document-processor.ts` calls `parsePDF` without try/catch.
 */
export async function parsePDF(
  data: ArrayBuffer,
  options: PDFParseOptions = {}
): Promise<PDFParseResult> {
  // The native path parses whole documents only; page ranges and
  // outline/annotation extraction are pdfjs-specific features.
  const nativeEligible =
    options.startPage === undefined &&
    options.endPage === undefined &&
    !options.extractOutline &&
    !options.extractAnnotations
  let fallbackDiagnostic: ParseDiagnostic | undefined

  if (nativeEligible && isTauri()) {
    try {
      const { parsePdfNative } = await import("./native-pdf")
      const native = await parsePdfNative(new Uint8Array(data), {
        ...(options.password !== undefined ? { password: options.password } : {}),
      })
      if (native.text.trim().length < SPARSE_TEXT_THRESHOLD) {
        native.diagnostics = [
          ...(native.diagnostics ?? []),
          {
            code: "sparse_text_layer",
            severity: "info",
            message:
              "Native parser found little or no text layer — the PDF is likely scanned; OCR may be required.",
          },
        ]
      }
      return native
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // `unsupported` = the parse-liteparse feature isn't compiled in.
      // That's an expected capability gap, not a failure — stay silent.
      if (!message.startsWith("unsupported")) {
        fallbackDiagnostic = {
          code: "native_parse_fallback",
          severity: "info",
          message: `Native PDF parser failed; fell back to pdfjs: ${message}`,
        }
      }
    }
  }

  // Dynamic import to avoid SSR issues
  const pdfjsLib = await import("pdfjs-dist")

  // Set worker source - use CDN for reliable cross-platform support
  // Note: We use CDN instead of bundled worker to avoid Next.js/Turbopack URL resolution issues
  if (typeof window !== "undefined" && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`
  }

  const docParams: Record<string, unknown> = { data }
  if (options.password) {
    docParams.password = options.password
  }

  const loadingTask = pdfjsLib.getDocument(docParams)
  const pdf = await loadingTask.promise

  const startPage = Math.max(1, options.startPage ?? 1)
  const endPage = Math.min(pdf.numPages, options.endPage ?? pdf.numPages)

  const pages: PDFPage[] = []
  const textParts: string[] = []
  const allAnnotations: PDFAnnotation[] = []

  // Extract text from each page with layout-aware paragraph detection
  for (let i = startPage; i <= endPage; i++) {
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()
    const viewport = page.getViewport({ scale: 1.0 })

    const pageText = extractTextWithLayout(textContent, viewport.height)

    pages.push({
      pageNumber: i,
      text: pageText,
      width: viewport.width,
      height: viewport.height,
    })

    textParts.push(pageText)

    // Extract annotations if requested
    if (options.extractAnnotations) {
      const pageAnnotations = await extractPageAnnotations(page, i)
      allAnnotations.push(...pageAnnotations)
    }
  }

  // Extract metadata
  const metadataObj = await pdf.getMetadata()
  const info = metadataObj.info as Record<string, unknown>

  const metadata: PDFMetadata = {
    title: info?.Title as string | undefined,
    author: info?.Author as string | undefined,
    subject: info?.Subject as string | undefined,
    keywords: info?.Keywords as string | undefined,
    creator: info?.Creator as string | undefined,
    producer: info?.Producer as string | undefined,
    creationDate: info?.CreationDate ? parseDate(info.CreationDate as string) : undefined,
    modificationDate: info?.ModDate ? parseDate(info.ModDate as string) : undefined,
  }

  // Extract outline/bookmarks if requested
  let outline: PDFOutlineItem[] | undefined
  if (options.extractOutline) {
    outline = await extractOutline(pdf)
  }

  const result: PDFParseResult = {
    text: textParts.join("\n\n"),
    pageCount: pdf.numPages,
    pages,
    metadata,
  }

  if (outline && outline.length > 0) {
    result.outline = outline
  }
  if (allAnnotations.length > 0) {
    result.annotations = allAnnotations
  }
  if (fallbackDiagnostic) {
    result.diagnostics = [fallbackDiagnostic]
  }

  return result
}

/**
 * Extract text with layout awareness - detects paragraphs via Y coordinate gaps
 */
function extractTextWithLayout(textContent: { items: unknown[] }, _pageHeight: number): string {
  const items = textContent.items.filter(
    (item): item is { str: string; transform: number[]; height: number } =>
      typeof item === "object" && item !== null && "str" in item && "transform" in item
  )

  if (items.length === 0) return ""

  // Sort items by Y position (descending, since PDF Y origin is bottom-left),
  // then by X position (ascending) for items on the same line
  const sorted = [...items].sort((a, b) => {
    const yA = a.transform[5]
    const yB = b.transform[5]
    const yDiff = yB - yA // descending Y (top of page first)
    if (Math.abs(yDiff) < 2) {
      // Same line - sort by X
      return a.transform[4] - b.transform[4]
    }
    return yDiff
  })

  const lines: string[] = []
  let currentLine: string[] = []
  let lastY = sorted[0].transform[5]
  let lastFontSize = sorted[0].height || 12

  for (const item of sorted) {
    if (!item.str.trim() && currentLine.length === 0) continue

    const y = item.transform[5]
    const yDiff = Math.abs(lastY - y)
    const lineThreshold = (lastFontSize || 12) * 0.5
    const paragraphThreshold = (lastFontSize || 12) * 1.8

    if (yDiff > lineThreshold && currentLine.length > 0) {
      // Flush current line
      lines.push(currentLine.join(" ").trim())
      currentLine = []

      // If gap is large enough, insert empty line for paragraph break
      if (yDiff > paragraphThreshold) {
        lines.push("")
      }
    }

    if (item.str.trim()) {
      currentLine.push(item.str)
    }

    lastY = y
    if (item.height > 0) {
      lastFontSize = item.height
    }
  }

  // Flush remaining line
  if (currentLine.length > 0) {
    lines.push(currentLine.join(" ").trim())
  }

  // Clean up: collapse multiple blank lines and trim
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Extract outline/bookmarks from PDF document
 */
async function extractOutline(pdf: {
  getOutline: () => Promise<unknown[] | null>
}): Promise<PDFOutlineItem[]> {
  try {
    const rawOutline = await pdf.getOutline()
    if (!rawOutline || rawOutline.length === 0) return []

    return convertOutlineItems(rawOutline)
  } catch {
    return []
  }
}

/**
 * Recursively convert raw PDF outline items to PDFOutlineItem format
 */
function convertOutlineItems(items: unknown[]): PDFOutlineItem[] {
  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const dest = item.dest
      let pageNumber: number | undefined

      // dest can be a string ref or array; for arrays, first element is the page ref
      if (
        Array.isArray(dest) &&
        dest.length > 0 &&
        typeof dest[0] === "object" &&
        dest[0] !== null
      ) {
        const pageRef = dest[0] as { num?: number }
        if (typeof pageRef.num === "number") {
          pageNumber = pageRef.num + 1 // 0-indexed to 1-indexed
        }
      }

      const children = Array.isArray(item.items) ? convertOutlineItems(item.items) : []

      return {
        title: String(item.title || ""),
        pageNumber,
        children,
      }
    })
    .filter((item) => item.title.length > 0)
}

/**
 * Extract annotations from a PDF page
 */
async function extractPageAnnotations(
  page: { getAnnotations: () => Promise<unknown[]> },
  pageNumber: number
): Promise<PDFAnnotation[]> {
  try {
    const rawAnnotations = await page.getAnnotations()
    if (!rawAnnotations || rawAnnotations.length === 0) return []

    return rawAnnotations
      .filter((ann): ann is Record<string, unknown> => typeof ann === "object" && ann !== null)
      .filter((ann) => {
        const subtype = String(ann.subtype || "")
        // Only extract content-bearing annotations
        return [
          "Text",
          "FreeText",
          "Highlight",
          "Underline",
          "StrikeOut",
          "Stamp",
          "Popup",
        ].includes(subtype)
      })
      .map((ann) => {
        const rect =
          Array.isArray(ann.rect) && ann.rect.length === 4
            ? {
                x: Number(ann.rect[0]),
                y: Number(ann.rect[1]),
                width: Number(ann.rect[2]) - Number(ann.rect[0]),
                height: Number(ann.rect[3]) - Number(ann.rect[1]),
              }
            : undefined

        const contentsObj = ann.contentsObj as Record<string, unknown> | undefined
        const content = String(ann.contents || contentsObj?.str || "")

        return {
          type: String(ann.subtype || "Unknown"),
          content,
          pageNumber,
          rect,
        }
      })
      .filter((ann) => ann.content.length > 0)
  } catch {
    return []
  }
}

/**
 * Parse PDF date string (D:YYYYMMDDHHmmSS format)
 */
function parseDate(dateStr: string): Date | undefined {
  if (!dateStr) return undefined

  // Remove "D:" prefix if present
  const cleaned = dateStr.replace(/^D:/, "")

  // Parse components
  const year = parseInt(cleaned.substring(0, 4), 10)
  const month = parseInt(cleaned.substring(4, 6), 10) - 1
  const day = parseInt(cleaned.substring(6, 8), 10)
  const hour = parseInt(cleaned.substring(8, 10), 10) || 0
  const minute = parseInt(cleaned.substring(10, 12), 10) || 0
  const second = parseInt(cleaned.substring(12, 14), 10) || 0

  if (isNaN(year)) return undefined

  return new Date(year, month, day, hour, minute, second)
}

/**
 * Parse PDF from File object
 */
export async function parsePDFFile(
  file: File,
  options: PDFParseOptions = {}
): Promise<PDFParseResult> {
  const buffer = await file.arrayBuffer()
  return parsePDF(buffer, options)
}

/**
 * Parse PDF from base64 string
 */
export async function parsePDFBase64(
  base64: string,
  options: PDFParseOptions = {}
): Promise<PDFParseResult> {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return parsePDF(bytes.buffer, options)
}

/**
 * Extract embeddable content from PDF (plain text suitable for embedding)
 */
export function extractPDFEmbeddableContent(result: PDFParseResult): string {
  const parts: string[] = []

  if (result.metadata.title) {
    parts.push(`Title: ${result.metadata.title}`)
  }

  if (result.metadata.author) {
    parts.push(`Author: ${result.metadata.author}`)
  }

  // Include outline as table of contents if available
  if (result.outline && result.outline.length > 0) {
    parts.push("Table of Contents:")
    parts.push(formatOutlineForEmbedding(result.outline, 0))
  }

  parts.push(result.text)

  // Include annotation contents if available
  if (result.annotations && result.annotations.length > 0) {
    const annotationTexts = result.annotations
      .filter((a) => a.content.trim().length > 0)
      .map((a) => `[${a.type} on page ${a.pageNumber}]: ${a.content}`)
    if (annotationTexts.length > 0) {
      parts.push("Annotations:")
      parts.push(annotationTexts.join("\n"))
    }
  }

  return parts.join("\n\n")
}

/**
 * Format outline items for embedding content
 */
function formatOutlineForEmbedding(items: PDFOutlineItem[], depth: number): string {
  return items
    .map((item) => {
      const indent = "  ".repeat(depth)
      const pageInfo = item.pageNumber ? ` (p.${item.pageNumber})` : ""
      const line = `${indent}- ${item.title}${pageInfo}`
      if (item.children.length > 0) {
        return line + "\n" + formatOutlineForEmbedding(item.children, depth + 1)
      }
      return line
    })
    .join("\n")
}
