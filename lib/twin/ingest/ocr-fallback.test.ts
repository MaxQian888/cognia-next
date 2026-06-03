const extractPdfMock = jest.fn()
const getSettingsMock = jest.fn()
jest.mock("@/lib/ocr/pdf-router", () => ({
  extractPdf: (...a: unknown[]) => extractPdfMock(...a),
}))
jest.mock("@/lib/ocr/pdf-loader", () => ({ createPdfLoader: () => "fake-loader" }))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: () => ({ settings: {} }) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettingsMock() }))

import {
  maybeTwinPdfOcr,
  runTwinPdfOcr,
  TWIN_OCR_MIN_TEXT_CHARS,
  type TwinOcrFallbackDeps,
} from "./ocr-fallback"
import type { RawSource, ParsedSource } from "./parse"
import type { OcrResult } from "@/types/ocr"

function ocrResult(text: string): OcrResult {
  return {
    providerId: "ocrs",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: text,
    combinedText: text,
    languages: ["en"],
    durationMs: 1,
    cached: false,
  }
}

function raw(over: Partial<RawSource> = {}): RawSource {
  return {
    id: "s1",
    filename: "scan.pdf",
    format: "pdf",
    binary: new Uint8Array([1, 2, 3]),
    ...over,
  }
}

function parsed(text: string): ParsedSource {
  return {
    id: "s1",
    kind: "document",
    format: "pdf",
    title: "scan.pdf",
    originalText: text,
    embeddableText: text,
    baseMetadata: {},
    bytes: 3,
  }
}

function deps(over: Partial<TwinOcrFallbackDeps> = {}): TwinOcrFallbackDeps {
  return {
    extractPdf: jest.fn(async () => ocrResult("OCR TEXT")),
    buildPdfRouterDeps: () => ({}) as ReturnType<TwinOcrFallbackDeps["buildPdfRouterDeps"]>,
    ...over,
  }
}

describe("maybeTwinPdfOcr", () => {
  it("returns null for non-PDF formats", async () => {
    const ex = jest.fn()
    expect(
      await maybeTwinPdfOcr(raw({ format: "docx" }), parsed(""), deps({ extractPdf: ex }))
    ).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("returns null when there is no binary", async () => {
    expect(await maybeTwinPdfOcr(raw({ binary: undefined }), parsed(""), deps())).toBeNull()
  })

  it("returns null when the text layer already has enough text", async () => {
    const ex = jest.fn()
    const text = "x".repeat(TWIN_OCR_MIN_TEXT_CHARS + 5)
    expect(await maybeTwinPdfOcr(raw(), parsed(text), deps({ extractPdf: ex }))).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("OCRs a low-text PDF and returns the extracted text", async () => {
    const ex = jest.fn(async () => ocrResult("SCANNED CONTENT"))
    const out = await maybeTwinPdfOcr(raw(), parsed("  \n "), deps({ extractPdf: ex }))
    expect(out).toBe("SCANNED CONTENT")
    expect(ex).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array) }, expect.anything())
  })

  it("returns null (non-fatal) when extractPdf throws", async () => {
    const ex = jest.fn(async () => {
      throw new Error("pdf boom")
    })
    expect(await maybeTwinPdfOcr(raw(), parsed(""), deps({ extractPdf: ex }))).toBeNull()
  })

  it("returns null when OCR yields blank text", async () => {
    const ex = jest.fn(async () => ocrResult("   "))
    expect(await maybeTwinPdfOcr(raw(), parsed(""), deps({ extractPdf: ex }))).toBeNull()
  })
})

describe("runTwinPdfOcr (production wrapper)", () => {
  beforeEach(() => {
    extractPdfMock.mockReset().mockResolvedValue(ocrResult("FROM SETTINGS"))
    getSettingsMock.mockReset().mockResolvedValue({ ocrSettings: undefined })
  })

  it("runs the OCR fallback for a low-text PDF", async () => {
    const out = await runTwinPdfOcr(raw(), parsed(""))
    expect(out).toBe("FROM SETTINGS")
    expect(extractPdfMock).toHaveBeenCalledTimes(1)
  })

  it("defaults gracefully when settings can't be read", async () => {
    getSettingsMock.mockRejectedValue(new Error("no dexie"))
    const out = await runTwinPdfOcr(raw(), parsed(""))
    expect(out).toBe("FROM SETTINGS")
  })
})
