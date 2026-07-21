// The per-page cache is injected through `ExtractDeps.pageCache` now, so these
// stand-ins are wired into the deps below instead of module-mocking "./cache".
const readCachedPage = jest.fn()
const writeCachedPage = jest.fn()

import { extractPdfStreaming } from "./pdf-stream"
import { createNullOcrCache } from "./cache-contract"
import { createOcrRegistry } from "./registry"
import { DEFAULT_OCR_SETTINGS } from "@/types/ocr"
import type { PdfDocument } from "./pdf-router"
import type { ExtractDeps } from "./index"

function fakeDoc(pageTexts: string[]): PdfDocument {
  return {
    numPages: pageTexts.length,
    async getPage(pageNumber: number) {
      return {
        pageNumber,
        async getTextContent() {
          const t = pageTexts[pageNumber - 1] ?? ""
          return { items: t ? t.split(" ").map((s) => ({ str: s })) : [] }
        },
        async renderToDataUrl() {
          return { dataUrl: "data:image/png;base64,YWJj", width: 100, height: 100 }
        },
      }
    },
  }
}

function deps(): ExtractDeps {
  return {
    registry: createOcrRegistry(),
    settings: DEFAULT_OCR_SETTINGS,
    platform: "web",
    credentialsResolver: async () => ({ secrets: {} }),
    cache: createNullOcrCache(),
    pageCache: {
      // Rest-forward so the stand-ins observe the exact arity the pipeline
      // used — naming `bytesIn` would append an extra `undefined` argument.
      read: (...args) => readCachedPage(...args),
      write: (...args) => writeCachedPage(...args),
    },
  }
}

beforeEach(() => {
  readCachedPage.mockReset().mockResolvedValue(null)
  writeCachedPage.mockReset().mockResolvedValue(undefined)
})

describe("extractPdfStreaming", () => {
  it("wires the per-page cache + onPage when a fileSha is given", async () => {
    const doc = fakeDoc(["a".repeat(40), "b".repeat(40)])
    const onPage = jest.fn()
    const out = await extractPdfStreaming(
      { bytes: new Uint8Array(), fileSha: "sha1", providerId: "ocrs", languages: ["en"] },
      { loadPdf: async () => doc, extractDeps: deps() },
      { onPage }
    )
    expect(out.pages).toHaveLength(2)
    expect(onPage).toHaveBeenCalledTimes(2)
    // cache consulted + written per page with the composed key.
    expect(readCachedPage).toHaveBeenCalledWith(
      expect.objectContaining({ fileSha: "sha1", providerId: "ocrs", pageNumber: 1 })
    )
    expect(writeCachedPage).toHaveBeenCalledTimes(2)
  })

  it("resumes: a cached page is reused and not written again", async () => {
    readCachedPage.mockImplementation(async (k: { pageNumber: number }) =>
      k.pageNumber === 1 ? { pageNumber: 1, markdown: "cached1", text: "cached1" } : null
    )
    const doc = fakeDoc(["x".repeat(40), "y".repeat(40)])
    const out = await extractPdfStreaming(
      { bytes: new Uint8Array(), fileSha: "sha1", providerId: "ocrs" },
      { loadPdf: async () => doc, extractDeps: deps() }
    )
    expect(out.pages[0]!.text).toBe("cached1")
    // only page 2 (uncached) gets written.
    expect(writeCachedPage).toHaveBeenCalledTimes(1)
    expect(writeCachedPage).toHaveBeenCalledWith(
      expect.objectContaining({ pageNumber: 2 }),
      expect.objectContaining({ pageNumber: 2 })
    )
  })

  it("skips the cache entirely when no fileSha is provided", async () => {
    const doc = fakeDoc(["a".repeat(40)])
    await extractPdfStreaming(
      { bytes: new Uint8Array() },
      { loadPdf: async () => doc, extractDeps: deps() }
    )
    expect(readCachedPage).not.toHaveBeenCalled()
    expect(writeCachedPage).not.toHaveBeenCalled()
  })

  it("honours useCache:false even with a fileSha", async () => {
    const doc = fakeDoc(["a".repeat(40)])
    await extractPdfStreaming(
      { bytes: new Uint8Array(), fileSha: "sha1" },
      { loadPdf: async () => doc, extractDeps: deps() },
      { useCache: false }
    )
    expect(readCachedPage).not.toHaveBeenCalled()
  })
})
