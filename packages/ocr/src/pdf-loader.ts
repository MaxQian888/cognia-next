/**
 * Production `PdfLoader` for `lib/ocr/pdf-router.ts:extractPdf`.
 *
 * Wraps `pdfjs-dist` so the PDF router can read each page's text layer and
 * rasterize the empty ones to a PNG data URL for OCR. Mirrors the worker setup
 * in `lib/document/parsers/pdf-parser.ts` (CDN worker to dodge Turbopack URL
 * resolution issues). Requires a DOM (`document` / `<canvas>`) — it runs in the
 * renderer/workbench, never the sidecar.
 *
 * Kept separate from `pdf-router.ts` so the router stays DOM-free and unit-
 * testable with a fake loader; this module owns the pdfjs + canvas coupling.
 */

import type { PdfDocument, PdfLoader } from "./pdf-router"

/** Lazily import pdfjs and configure its worker exactly once. */
async function loadPdfjs() {
  const pdfjsLib = await import("pdfjs-dist")
  if (typeof window !== "undefined" && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`
  }
  return pdfjsLib
}

/**
 * The shared production loader. Pass as `PdfRouterDeps.loadPdf`. The optional
 * `createCanvas` seam lets tests inject a fake canvas without a real DOM.
 */
export function createPdfLoader(opts?: {
  createCanvas?: (
    width: number,
    height: number
  ) => {
    width: number
    height: number
    getContext: (id: "2d") => unknown
    toDataURL: (type?: string) => string
  }
}): PdfLoader {
  const makeCanvas =
    opts?.createCanvas ??
    ((width: number, height: number) => {
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      return canvas
    })

  return async ({ bytes }): Promise<PdfDocument> => {
    const pdfjsLib = await loadPdfjs()
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise
    return {
      numPages: doc.numPages,
      async getPage(pageNumber: number) {
        const page = await doc.getPage(pageNumber)
        return {
          pageNumber,
          async getTextContent() {
            const content = (await page.getTextContent()) as { items: Array<{ str?: string }> }
            return { items: content.items.map((i) => ({ str: i.str ?? "" })) }
          },
          async renderToDataUrl({ dpi }: { dpi: number }) {
            const viewport = page.getViewport({ scale: dpi / 72 })
            const width = Math.ceil(viewport.width)
            const height = Math.ceil(viewport.height)
            const canvas = makeCanvas(width, height)
            const canvasContext = canvas.getContext("2d")
            await page.render({
              canvas: canvas as unknown as HTMLCanvasElement,
              canvasContext: canvasContext as CanvasRenderingContext2D,
              viewport,
            }).promise
            return { dataUrl: canvas.toDataURL("image/png"), width, height }
          },
        }
      },
    }
  }
}
