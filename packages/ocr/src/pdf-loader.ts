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

  return async ({ bytes, signal }): Promise<PdfDocument> => {
    signal?.throwIfAborted()
    const pdfjsLib = await loadPdfjs()
    signal?.throwIfAborted()
    const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() })
    let destruction: Promise<void> | undefined
    const destroy = () => (destruction ??= loadingTask.destroy())
    const cancelLoading = () => {
      void destroy().catch(() => undefined)
    }
    signal?.addEventListener("abort", cancelLoading, { once: true })
    let doc
    try {
      doc = await loadingTask.promise
      signal?.throwIfAborted()
    } catch (error) {
      await destroy()
      throw error
    } finally {
      signal?.removeEventListener("abort", cancelLoading)
    }
    return {
      numPages: doc.numPages,
      destroy,
      async getPage(pageNumber: number) {
        const page = await doc.getPage(pageNumber)
        return {
          pageNumber,
          cleanup: () => {
            page.cleanup()
          },
          async getTextContent() {
            const content = (await page.getTextContent()) as { items: Array<{ str?: string }> }
            return { items: content.items.map((i) => ({ str: i.str ?? "" })) }
          },
          async renderToDataUrl({ dpi, signal }: { dpi: number; signal?: AbortSignal }) {
            signal?.throwIfAborted()
            const viewport = page.getViewport({ scale: dpi / 72 })
            const width = Math.ceil(viewport.width)
            const height = Math.ceil(viewport.height)
            const canvas = makeCanvas(width, height)
            const canvasContext = canvas.getContext("2d")
            const task = page.render({
              canvas: canvas as unknown as HTMLCanvasElement,
              canvasContext: canvasContext as CanvasRenderingContext2D,
              viewport,
            })
            const cancelRender = () => task.cancel()
            signal?.addEventListener("abort", cancelRender, { once: true })
            try {
              await task.promise
              signal?.throwIfAborted()
              return { dataUrl: canvas.toDataURL("image/png"), width, height }
            } finally {
              signal?.removeEventListener("abort", cancelRender)
              canvas.width = 0
              canvas.height = 0
            }
          },
        }
      },
    }
  }
}
