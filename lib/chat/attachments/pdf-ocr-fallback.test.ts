const extractPdfMock = jest.fn()
const getSettingsMock = jest.fn()
jest.mock("@/lib/ocr/pdf-router", () => ({
  extractPdf: (...args: unknown[]) => extractPdfMock(...args),
}))
jest.mock("@/lib/ocr/pdf-loader", () => ({ createPdfLoader: () => jest.fn() }))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: () => ({ settings: {} }) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettingsMock() }))

import {
  extractAttachmentPdf,
  maybeAttachmentPdfOcr,
  runAttachmentPdfExtraction,
  runAttachmentPdfOcr,
  type AttachmentPdfOcrDeps,
} from "./pdf-ocr-fallback"
import type { OcrPage, OcrResult } from "@/types/ocr"
import type { PdfRouterDeps } from "@/lib/ocr/pdf-router"

const bytes = new Uint8Array([1, 2, 3])
const page = (
  pageNumber: number,
  text = `Page ${pageNumber} text content`,
  fromTextLayer = true
): OcrPage => ({ pageNumber, text, markdown: text, fromTextLayer })
const result = (pages: OcrPage[]): OcrResult => ({
  providerId: "test",
  pages,
  combinedText: pages.map((p) => p.text).join("\n"),
  combinedMarkdown: "",
  languages: ["en"],
  durationMs: 1,
  cached: false,
})
const deps = (extractPdf: AttachmentPdfOcrDeps["extractPdf"]): AttachmentPdfOcrDeps => ({
  extractPdf,
  buildPdfRouterDeps: () => ({ extractDeps: {} }) as PdfRouterDeps,
})

describe("complete PDF attachment extraction", () => {
  it("processes every page after page 20, retaining mixed text/OCR locators and progress", async () => {
    const progress = jest.fn()
    const extractPdf = jest.fn(async (_input, router: PdfRouterDeps) => {
      router.onDocument?.(25)
      const pages = Array.from({ length: 25 }, (_, i) =>
        page(i + 1, `Content ${i + 1}`, i % 2 === 0)
      )
      pages.forEach((p, index) => router.onPage?.(p, index + 1, 25))
      return result(pages)
    })
    const outcome = await extractAttachmentPdf(bytes, { onProgress: progress }, deps(extractPdf))
    expect(extractPdf.mock.calls[0][0]).toEqual({ bytes })
    expect(outcome).toMatchObject({
      totalPages: 25,
      processedPages: 25,
      ocrPages: 12,
      status: "complete",
      capped: false,
    })
    expect(outcome.pages).toHaveLength(25)
    expect(outcome.text).toContain("[Page 25]\nContent 25")
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ totalPages: 25, processedPages: 25 })
    )
  })

  it("never treats rich aggregate text as proof that all PDF pages were extracted", async () => {
    const extractPdf = jest.fn(async () => result([page(1), page(2, "Scanned appendix", false)]))
    const outcome = await maybeAttachmentPdfOcr(
      bytes,
      "Digital cover ".repeat(100),
      deps(extractPdf)
    )
    expect(extractPdf).toHaveBeenCalledTimes(1)
    expect(outcome?.text).toContain("Scanned appendix")
  })

  it("reuses only substantive known text pages and routes sparse pages to OCR", async () => {
    await extractAttachmentPdf(
      bytes,
      { textPages: [page(1, "Long digital document page text"), page(2, "")] },
      deps(async (_input, router) => {
        expect(await router.readPage?.(1)).toMatchObject({
          fromTextLayer: true,
          text: "Long digital document page text",
        })
        expect(await router.readPage?.(2)).toBeNull()
        expect(await router.readPage?.(3)).toBeNull()
        return result([])
      })
    )
  })

  it("retains good pages and explicit failed-page gaps while later pages continue", async () => {
    const outcome = await extractAttachmentPdf(
      bytes,
      {},
      deps(async (_input, router) => {
        router.onDocument?.(3)
        router.onPage?.(page(1), 1, 3)
        router.onPageError?.(new Error("OCR engine failed"), 2, 2, 3)
        router.onPage?.(page(3), 3, 3)
        return result([page(1), page(3)])
      })
    )
    expect(outcome).toMatchObject({
      status: "partial",
      processedPages: 3,
      errors: [{ pageNumber: 2, message: "OCR engine failed" }],
    })
    expect(outcome.pages.map((p) => p.pageNumber)).toEqual([1, 3])
  })

  it("retains partial pages when cancelled and does not report completed extraction", async () => {
    const controller = new AbortController()
    const outcome = await extractAttachmentPdf(
      bytes,
      { signal: controller.signal },
      deps(async (_input, router) => {
        router.onDocument?.(3)
        router.onPage?.(page(1), 1, 3)
        controller.abort()
        throw new DOMException("cancelled", "AbortError")
      })
    )
    expect(outcome).toMatchObject({ status: "cancelled", processedPages: 1, totalPages: 3 })
    expect(outcome.pages).toHaveLength(1)
  })

  it("reports loader and zero-success errors without hiding the failure", async () => {
    const outcome = await extractAttachmentPdf(
      bytes,
      {},
      deps(async () => {
        throw new Error("bad PDF")
      })
    )
    expect(outcome).toMatchObject({ status: "failed", pages: [], errors: [{ message: "bad PDF" }] })
  })

  it("does not start work for an already-cancelled attachment", async () => {
    const controller = new AbortController()
    controller.abort()
    const extractPdf = jest.fn()
    expect(
      await extractAttachmentPdf(bytes, { signal: controller.signal }, deps(extractPdf))
    ).toMatchObject({ status: "cancelled" })
    expect(extractPdf).not.toHaveBeenCalled()
  })
})

describe("production wrappers", () => {
  beforeEach(() => {
    extractPdfMock.mockReset().mockResolvedValue(result([page(1, "Full attachment text", false)]))
    getSettingsMock.mockReset().mockResolvedValue({})
  })
  it("returns structured extraction through the production OCR settings", async () => {
    expect(await runAttachmentPdfExtraction(bytes)).toMatchObject({
      status: "complete",
      ocrPages: 1,
    })
  })
  it("keeps the legacy string facade with page locators", async () => {
    expect(await runAttachmentPdfOcr(bytes, "rich cover".repeat(20))).toBe(
      "[Page 1]\nFull attachment text"
    )
  })
  it("uses defaults when settings are unavailable", async () => {
    getSettingsMock.mockRejectedValue(new Error("offline"))
    expect(await runAttachmentPdfExtraction(bytes)).toMatchObject({ status: "complete" })
  })
  it("adds an explicit notice for legacy callers receiving a partial result", async () => {
    extractPdfMock.mockImplementation(async (_input, router) => {
      router.onDocument(2)
      router.onPage(page(1), 1, 2)
      router.onPageError(new Error("broken"), 2, 2, 2)
      return result([page(1)])
    })
    expect(await runAttachmentPdfOcr(bytes, "")).toContain(
      "PDF extraction partial: 1 of 2 pages available"
    )
  })
})
