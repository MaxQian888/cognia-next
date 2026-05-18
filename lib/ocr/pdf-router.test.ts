import { MIN_TEXT_LAYER_CHARS, extractPdf, type PdfDocument } from "./pdf-router"
import { createOcrRegistry } from "./registry"
import { DEFAULT_OCR_SETTINGS, type OcrResult, type UserOcrSettings } from "./types"
import type { ExtractDeps } from "./index"

interface FakePageOptions {
  pageNumber: number
  /** Text returned by getTextContent() (joined). */
  text?: string
  /** Force the rasterized path even when text would qualify. */
  emptyTextLayer?: boolean
}

function makeFakeDoc(pages: FakePageOptions[]): PdfDocument {
  return {
    numPages: pages.length,
    async getPage(pageNumber: number) {
      const spec = pages.find((p) => p.pageNumber === pageNumber) ?? { pageNumber, text: "" }
      return {
        pageNumber,
        async getTextContent() {
          const text = spec.emptyTextLayer ? "" : (spec.text ?? "")
          return { items: text ? text.split(" ").map((s) => ({ str: s })) : [] }
        },
        async renderToDataUrl({ dpi }) {
          void dpi
          return {
            dataUrl: `data:image/png;base64,YWJj`,
            width: 800,
            height: 1000,
          }
        },
      }
    },
  }
}

function makeDeps(): {
  deps: ExtractDeps
  settings: UserOcrSettings
  ocrPage: jest.Mock<Promise<OcrResult>, unknown[]>
} {
  const settings: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "mock" }
  const deps: ExtractDeps = {
    registry: createOcrRegistry(),
    settings,
    platform: "web",
    credentialsResolver: async () => ({ secrets: {} }),
  }
  const ocrPage = jest.fn(
    async (): Promise<OcrResult> => ({
      providerId: "mock",
      pages: [{ pageNumber: 1, markdown: "# OCR'd", text: "OCR'd" }],
      combinedMarkdown: "# OCR'd",
      combinedText: "OCR'd",
      languages: ["en"],
      durationMs: 5,
      cached: false,
    })
  )
  return { deps, settings, ocrPage }
}

describe("MIN_TEXT_LAYER_CHARS", () => {
  it("defaults to 16", () => {
    expect(MIN_TEXT_LAYER_CHARS).toBe(16)
  })
})

describe("extractPdf — text-layer fast-path", () => {
  it("uses extracted text when the page has substantive text", async () => {
    const { deps, ocrPage } = makeDeps()
    const doc = makeFakeDoc([
      {
        pageNumber: 1,
        text: "This is a long enough digital PDF page with real text",
      },
    ])
    const result = await extractPdf(
      { bytes: new Uint8Array([1, 2, 3]) },
      { loadPdf: async () => doc, ocrPage, extractDeps: deps }
    )
    expect(result.pages[0]!.fromTextLayer).toBe(true)
    expect(result.pages[0]!.text).toContain("digital PDF")
    expect(ocrPage).not.toHaveBeenCalled()
  })

  it("falls through to OCR when the text layer is empty", async () => {
    const { deps, ocrPage } = makeDeps()
    const doc = makeFakeDoc([{ pageNumber: 1, emptyTextLayer: true }])
    const result = await extractPdf(
      { bytes: new Uint8Array([1, 2, 3]) },
      { loadPdf: async () => doc, ocrPage, extractDeps: deps }
    )
    expect(ocrPage).toHaveBeenCalledTimes(1)
    expect(result.pages[0]!.fromTextLayer).toBe(false)
    expect(result.pages[0]!.text).toBe("OCR'd")
    expect(result.pages[0]!.width).toBe(800)
  })

  it("falls through to OCR when the text layer is shorter than the threshold", async () => {
    const { deps, ocrPage } = makeDeps()
    const doc = makeFakeDoc([{ pageNumber: 1, text: "abc" }]) // < 16 chars
    await extractPdf(
      { bytes: new Uint8Array([1, 2, 3]) },
      { loadPdf: async () => doc, ocrPage, extractDeps: deps }
    )
    expect(ocrPage).toHaveBeenCalled()
  })

  it("respects a caller-supplied minTextLayerChars override", async () => {
    const { deps, ocrPage } = makeDeps()
    const doc = makeFakeDoc([{ pageNumber: 1, text: "abc" }])
    await extractPdf(
      { bytes: new Uint8Array([1, 2, 3]) },
      { loadPdf: async () => doc, ocrPage, extractDeps: deps, minTextLayerChars: 1 }
    )
    expect(ocrPage).not.toHaveBeenCalled()
  })
})

describe("extractPdf — page ranges", () => {
  it("processes every page when no range is supplied", async () => {
    const { deps, ocrPage } = makeDeps()
    const doc = makeFakeDoc([
      { pageNumber: 1, text: "page one is long enough so we skip OCR" },
      { pageNumber: 2, text: "page two is also long enough to skip OCR" },
    ])
    const result = await extractPdf(
      { bytes: new Uint8Array([1, 2, 3]) },
      { loadPdf: async () => doc, ocrPage, extractDeps: deps }
    )
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2])
  })

  it("honours an explicit page range", async () => {
    const { deps, ocrPage } = makeDeps()
    const doc = makeFakeDoc([
      { pageNumber: 1, text: "first long-enough page text" },
      { pageNumber: 2, text: "second long-enough page text" },
      { pageNumber: 3, text: "third long-enough page text" },
    ])
    const result = await extractPdf(
      { bytes: new Uint8Array([1, 2, 3]), pageRange: "2-3" },
      { loadPdf: async () => doc, ocrPage, extractDeps: deps }
    )
    expect(result.pages.map((p) => p.pageNumber)).toEqual([2, 3])
  })

  it("clamps a range that exceeds numPages", async () => {
    const { deps, ocrPage } = makeDeps()
    const doc = makeFakeDoc([{ pageNumber: 1, text: "long enough page text" }])
    const result = await extractPdf(
      { bytes: new Uint8Array([1, 2, 3]), pageRange: "1-10" },
      { loadPdf: async () => doc, ocrPage, extractDeps: deps }
    )
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1])
  })

  it("joins multi-page Markdown with the page divider", async () => {
    const { deps, ocrPage } = makeDeps()
    const doc = makeFakeDoc([
      { pageNumber: 1, text: "first long-enough page text" },
      { pageNumber: 2, text: "second long-enough page text" },
    ])
    const result = await extractPdf(
      { bytes: new Uint8Array([1, 2, 3]) },
      { loadPdf: async () => doc, ocrPage, extractDeps: deps }
    )
    expect(result.combinedMarkdown).toContain("<!-- page 1 -->")
    expect(result.combinedMarkdown).toContain("<!-- page 2 -->")
    expect(result.combinedMarkdown).toContain("---")
  })
})

describe("extractPdf — error paths", () => {
  it("wraps loader failures into invalid_input", async () => {
    const { deps } = makeDeps()
    await expect(
      extractPdf(
        { bytes: new Uint8Array([0]) },
        {
          loadPdf: async () => {
            throw new Error("not a pdf")
          },
          extractDeps: deps,
        }
      )
    ).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("propagates OCR errors from per-page extraction", async () => {
    const { deps } = makeDeps()
    const ocrPage = jest.fn(async () => {
      throw new Error("network down")
    })
    const doc = makeFakeDoc([{ pageNumber: 1, emptyTextLayer: true }])
    await expect(
      extractPdf(
        { bytes: new Uint8Array([1, 2, 3]) },
        { loadPdf: async () => doc, ocrPage, extractDeps: deps }
      )
    ).rejects.toThrow(/network down/)
  })
})
