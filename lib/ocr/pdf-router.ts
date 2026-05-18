/**
 * PDF router — short-circuits to the existing text layer for digital PDFs,
 * rasterizes + OCRs only the pages that come back empty.
 *
 * Decision per page:
 *   1. `page.getTextContent()` is called via pdfjs-dist.
 *   2. If the concatenated text length ≥ {@link MIN_TEXT_LAYER_CHARS} (default
 *      16), we accept the layer-extracted text and skip OCR for that page.
 *   3. Otherwise the page is rasterized via `page.render({ canvasContext })`
 *      to a PNG data URL, and the configured OCR provider is invoked.
 *
 * pdfjs-dist requires a browser-ish runtime (canvas, worker). The router is
 * shaped so tests can pass a fake `loadPdf` that returns a stub document with
 * canned pages — the production loader dynamically imports pdfjs at first use.
 */

import { extract as defaultExtract } from "./index"
import { combinePageMarkdown, combinePageText, parsePageRange } from "./image-prep"
import {
  OcrError,
  type OcrInput,
  type OcrPage,
  type OcrResult,
  type UserOcrSettings,
} from "./types"
import type { ExtractDeps } from "./index"

export const MIN_TEXT_LAYER_CHARS = 16

/** Slim slice of pdfjs-dist's document/page API actually used here. */
export interface PdfTextItem {
  str: string
}
export interface PdfTextContent {
  items: PdfTextItem[]
}
export interface PdfPage {
  pageNumber: number
  /** Render the page to a data URL at the requested DPI. */
  renderToDataUrl(opts: {
    dpi: number
  }): Promise<{ dataUrl: string; width: number; height: number }>
  getTextContent(): Promise<PdfTextContent>
}
export interface PdfDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPage>
}

export type PdfLoader = (input: { bytes: Uint8Array }) => Promise<PdfDocument>

export interface PdfRouterDeps {
  loadPdf: PdfLoader
  /**
   * Function used to OCR a single rasterized page. Defaults to calling the
   * shared `extract()` from `./index.ts`.
   */
  ocrPage?: (input: OcrInput, deps: ExtractDeps) => Promise<OcrResult>
  /** Whole-OCR deps reused for per-page calls. */
  extractDeps: ExtractDeps
  /** Caller-supplied settings — defaults to `extractDeps.settings`. */
  settings?: UserOcrSettings
  /** DPI used when rasterizing empty pages. Default 220. */
  dpi?: number
  /** Override the text-layer threshold; default {@link MIN_TEXT_LAYER_CHARS}. */
  minTextLayerChars?: number
  /** Provider id passed to the OCR call when a page is empty. */
  ocrProviderId?: string
}

export interface PdfRouterInput {
  bytes: Uint8Array
  /** "1,3-5" syntax. Defaults to "all pages". */
  pageRange?: string
  languages?: string[]
}

/** Single-document Markdown extraction with the text-layer fast-path. */
export async function extractPdf(input: PdfRouterInput, deps: PdfRouterDeps): Promise<OcrResult> {
  const ocrFn = deps.ocrPage ?? defaultExtract
  const dpi = deps.dpi ?? 220
  const threshold = deps.minTextLayerChars ?? MIN_TEXT_LAYER_CHARS
  const settings = deps.settings ?? deps.extractDeps.settings
  const ocrProviderId = deps.ocrProviderId

  let doc: PdfDocument
  try {
    doc = await deps.loadPdf({ bytes: input.bytes })
  } catch (err) {
    throw new OcrError(
      "invalid_input",
      "pdf-router",
      err instanceof Error ? err.message : "Failed to load PDF",
      err
    )
  }

  const pagesToRead = parsePageRange(input.pageRange, doc.numPages) ?? rangeOf(doc.numPages)
  const pages: OcrPage[] = []
  const start = Date.now()
  for (const pageNumber of pagesToRead) {
    const page = await doc.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const text = joinPdfText(textContent)
    if (text.replace(/\s+/g, "").length >= threshold) {
      pages.push({
        pageNumber,
        markdown: synthesizeMarkdown(text),
        text,
        fromTextLayer: true,
      })
      continue
    }
    const rasterized = await page.renderToDataUrl({ dpi })
    const ocrResult = await ocrFn(
      {
        source: {
          kind: "data-url",
          dataUrl: rasterized.dataUrl,
          mimeType: "image/png",
        },
        providerId: ocrProviderId,
        languages: input.languages ?? settings.defaultLanguages,
        useCache: false,
      },
      deps.extractDeps
    )
    const firstPage = ocrResult.pages[0]
    pages.push({
      pageNumber,
      markdown: firstPage?.markdown ?? "",
      text: firstPage?.text ?? "",
      blocks: firstPage?.blocks,
      width: rasterized.width,
      height: rasterized.height,
      fromTextLayer: false,
    })
  }

  return {
    providerId: ocrProviderId ?? "pdf-router",
    pages,
    combinedMarkdown: combinePageMarkdown(pages),
    combinedText: combinePageText(pages),
    languages: input.languages ?? settings.defaultLanguages,
    durationMs: Date.now() - start,
    cached: false,
  }
}

function rangeOf(total: number): number[] {
  return Array.from({ length: total }, (_unused, i) => i + 1)
}

function joinPdfText(content: PdfTextContent): string {
  return (content.items ?? [])
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

function synthesizeMarkdown(text: string): string {
  return text
}

/**
 * Default loader — pulls in pdfjs-dist lazily. Provided as a function so the
 * tree-shaker can keep pdfjs out of the static export when no caller invokes
 * the PDF router (browser bundle savings).
 */
export const defaultPdfLoader: PdfLoader = async ({ bytes }) => {
  const pdfjs = (await import(
    /* webpackIgnore: true */ "pdfjs-dist"
  )) as typeof import("pdfjs-dist")
  const loadingTask = pdfjs.getDocument({ data: bytes })
  const document = await loadingTask.promise
  return {
    numPages: document.numPages,
    async getPage(pageNumber: number) {
      const page = await document.getPage(pageNumber)
      return {
        pageNumber: page.pageNumber,
        async renderToDataUrl({ dpi }) {
          const viewport = page.getViewport({ scale: dpi / 72 })
          const canvas = document?.constructor // narrow types: document doesn't expose DOM
          const offscreenCanvas =
            typeof OffscreenCanvas !== "undefined"
              ? new OffscreenCanvas(viewport.width, viewport.height)
              : null
          if (offscreenCanvas) {
            const ctx = offscreenCanvas.getContext("2d")
            if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable")
            await page.render({
              canvasContext: ctx as unknown as CanvasRenderingContext2D,
              viewport,
              canvas: offscreenCanvas as unknown as HTMLCanvasElement,
            }).promise
            const blob = await offscreenCanvas.convertToBlob({ type: "image/png" })
            const dataUrl = await blobToDataUrl(blob)
            return { dataUrl, width: viewport.width, height: viewport.height }
          }
          if (typeof globalThis.document === "undefined") {
            throw new Error("PDF rasterization requires canvas (OffscreenCanvas or DOM canvas)")
          }
          const domCanvas = globalThis.document.createElement("canvas")
          domCanvas.width = viewport.width
          domCanvas.height = viewport.height
          const ctx = domCanvas.getContext("2d")
          if (!ctx) throw new Error("DOM canvas 2D context unavailable")
          await page.render({ canvasContext: ctx, viewport, canvas: domCanvas }).promise
          const dataUrl = domCanvas.toDataURL("image/png")
          // silence unused-name warning if pdfjs ever names things differently
          void canvas
          return { dataUrl, width: viewport.width, height: viewport.height }
        },
        async getTextContent() {
          const content = await page.getTextContent()
          return {
            items: content.items
              .map((it) =>
                it && typeof it === "object" && "str" in it
                  ? { str: String((it as { str: unknown }).str) }
                  : null
              )
              .filter((it): it is { str: string } => it !== null),
          }
        },
      }
    },
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : "")
      fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"))
      fr.readAsDataURL(blob)
    })
  }
  // Fallback (jsdom without FileReader) — base64-encode by hand.
  const buf = await (blob as Blob & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()
  const bin = Buffer.from(new Uint8Array(buf)).toString("base64")
  return `data:${blob.type || "application/octet-stream"};base64,${bin}`
}
