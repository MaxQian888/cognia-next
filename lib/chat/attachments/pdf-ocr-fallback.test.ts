/**
 * Tests for the scanned-PDF OCR fallback used by the composer attachment
 * dispatch. The pure `maybeAttachmentPdfOcr` is exercised with injected
 * `extractPdf` + `loadPdf` stubs (no real pdfjs/tesseract); the production
 * `runAttachmentPdfOcr` wrapper is checked with the heavy modules mocked.
 */

const extractPdfMock = jest.fn()
const getSettingsMock = jest.fn()
jest.mock("@/lib/ocr/pdf-router", () => ({
  extractPdf: (...a: unknown[]) => extractPdfMock(...a),
}))
jest.mock("@/lib/ocr/pdf-loader", () => ({
  // Returns a callable loader yielding a 1-page doc so the pre-count step
  // in maybeAttachmentPdfOcr succeeds.
  createPdfLoader: () => async () => ({ numPages: 1, getPage: jest.fn() }),
}))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: () => ({ settings: {} }) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettingsMock() }))

import {
  maybeAttachmentPdfOcr,
  runAttachmentPdfOcr,
  ATTACHMENT_OCR_MIN_TEXT_CHARS,
  ATTACHMENT_OCR_MAX_PAGES,
  type AttachmentPdfOcrDeps,
} from "./pdf-ocr-fallback"
import type { OcrResult } from "@/types/ocr"
import type { PdfDocument } from "@/lib/ocr/pdf-router"

function ocrResult(text: string): OcrResult {
  return {
    providerId: "tesseract-wasm",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: text,
    combinedText: text,
    languages: ["en"],
    durationMs: 1,
    cached: false,
  }
}

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

function deps(over: Partial<AttachmentPdfOcrDeps> = {}, numPages = 2): AttachmentPdfOcrDeps {
  const fakeDoc: PdfDocument = {
    numPages,
    getPage: jest.fn(),
  }
  return {
    extractPdf: jest.fn(async () => ocrResult("OCR TEXT")),
    buildPdfRouterDeps: () =>
      ({
        loadPdf: jest.fn(async () => fakeDoc),
        extractDeps: {} as never,
      }) as never,
    ...over,
  }
}

describe("maybeAttachmentPdfOcr", () => {
  it("returns null when the text layer already has enough text", async () => {
    const ex = jest.fn()
    const text = "x".repeat(ATTACHMENT_OCR_MIN_TEXT_CHARS + 5)
    expect(await maybeAttachmentPdfOcr(bytes, text, deps({ extractPdf: ex }))).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("OCRs a low-text PDF and returns the extracted text", async () => {
    const ex = jest.fn(async () => ocrResult("SCANNED CONTENT"))
    const out = await maybeAttachmentPdfOcr(bytes, "  \n ", deps({ extractPdf: ex }))
    expect(out).toEqual({
      text: "SCANNED CONTENT",
      totalPages: 2,
      ocrPages: 2,
      capped: false,
    })
    expect(ex).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array) }, expect.anything())
  })

  it("does not pass a pageRange when the PDF is within the cap", async () => {
    const ex = jest.fn(async () => ocrResult("WITHIN CAP"))
    await maybeAttachmentPdfOcr(bytes, "", deps({ extractPdf: ex }, ATTACHMENT_OCR_MAX_PAGES))
    expect(ex).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array) }, expect.anything())
  })

  it("caps a very large PDF, logs the cap, and surfaces it in the text", async () => {
    const ex = jest.fn(async () => ocrResult("FIRST PAGES"))
    const log = jest.fn()
    const out = await maybeAttachmentPdfOcr(
      bytes,
      "",
      deps({ extractPdf: ex, maxPages: 3, log }, 50)
    )
    expect(ex).toHaveBeenCalledWith(
      { bytes: expect.any(Uint8Array), pageRange: "1-3" },
      expect.anything()
    )
    expect(out).toMatchObject({ totalPages: 50, ocrPages: 3, capped: true })
    expect(out!.text).toContain("first 3 of 50 pages")
    expect(out!.text).toContain("FIRST PAGES")
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("capped"),
      expect.objectContaining({ totalPages: 50, maxPages: 3 })
    )
  })

  it("uses the custom minTextChars threshold", async () => {
    const ex = jest.fn(async () => ocrResult("OCR"))
    // 10 chars present, threshold 5 → no OCR.
    expect(
      await maybeAttachmentPdfOcr(bytes, "0123456789", deps({ extractPdf: ex, minTextChars: 5 }))
    ).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("returns null when the document reports zero pages", async () => {
    const ex = jest.fn(async () => ocrResult("never"))
    expect(await maybeAttachmentPdfOcr(bytes, "", deps({ extractPdf: ex }, 0))).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("returns null (non-fatal) when loadPdf throws", async () => {
    const out = await maybeAttachmentPdfOcr(bytes, "", {
      extractPdf: jest.fn(async () => ocrResult("unused")),
      buildPdfRouterDeps: () =>
        ({
          loadPdf: jest.fn(async () => {
            throw new Error("bad pdf")
          }),
          extractDeps: {} as never,
        }) as never,
    })
    expect(out).toBeNull()
  })

  it("returns null (non-fatal) when extractPdf throws", async () => {
    const ex = jest.fn(async () => {
      throw new Error("ocr boom")
    })
    expect(await maybeAttachmentPdfOcr(bytes, "", deps({ extractPdf: ex }))).toBeNull()
  })

  it("returns null when OCR yields blank text", async () => {
    const ex = jest.fn(async () => ocrResult("   "))
    expect(await maybeAttachmentPdfOcr(bytes, "", deps({ extractPdf: ex }))).toBeNull()
  })

  it("defaults the logger to the media logger when none is injected", async () => {
    // No `log` override + a capped doc exercises the default logger branch
    // without asserting on the singleton (it must simply not throw).
    const ex = jest.fn(async () => ocrResult("BODY"))
    const out = await maybeAttachmentPdfOcr(bytes, "", deps({ extractPdf: ex, maxPages: 1 }, 9))
    expect(out).toMatchObject({ capped: true })
  })
})

describe("runAttachmentPdfOcr (production wrapper)", () => {
  beforeEach(() => {
    extractPdfMock.mockReset().mockResolvedValue(ocrResult("FROM SETTINGS"))
    getSettingsMock.mockReset().mockResolvedValue({ ocrSettings: undefined })
  })

  it("runs the OCR fallback for a low-text PDF and returns its text", async () => {
    const out = await runAttachmentPdfOcr(bytes, "")
    expect(out).toBe("FROM SETTINGS")
    expect(extractPdfMock).toHaveBeenCalledTimes(1)
  })

  it("returns null when the text layer is already rich (no OCR)", async () => {
    const out = await runAttachmentPdfOcr(bytes, "y".repeat(100))
    expect(out).toBeNull()
    expect(extractPdfMock).not.toHaveBeenCalled()
  })

  it("defaults gracefully when settings can't be read", async () => {
    getSettingsMock.mockRejectedValue(new Error("no dexie"))
    const out = await runAttachmentPdfOcr(bytes, "")
    expect(out).toBe("FROM SETTINGS")
  })
})
