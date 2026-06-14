const extractMock = jest.fn()
const getSettingsMock = jest.fn()
const appendAuditMock = jest.fn()
jest.mock("@/lib/ocr", () => ({ extract: (...a: unknown[]) => extractMock(...a) }))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: () => ({}) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettingsMock() }))
jest.mock("./audit", () => ({
  __esModule: true,
  appendAudit: (...a: unknown[]) => appendAuditMock(...a),
}))

import { maybeOcrInboundSegments, runInboundOcr, type InboundOcrDeps } from "./inbound-ocr"
import type { MessageSegment } from "@/types/connectors/segment"
import type { OcrResult } from "@/types/ocr"

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

function imageSeg(extra: Record<string, unknown> = {}): MessageSegment {
  return { type: "image", url: "img://1", ...extra } as MessageSegment
}

function deps(over: Partial<InboundOcrDeps> = {}): InboundOcrDeps {
  return {
    enabled: true,
    extract: jest.fn(async () => ocrResult("HELLO")),
    ocrDeps: {} as InboundOcrDeps["ocrDeps"],
    ...over,
  }
}

describe("maybeOcrInboundSegments", () => {
  it("no-ops when disabled", async () => {
    const extract = jest.fn(async () => ocrResult("X"))
    const segs = [imageSeg({ dataBase64: "AAAA" })]
    await maybeOcrInboundSegments(segs, deps({ enabled: false, extract }))
    expect(extract).not.toHaveBeenCalled()
    expect((segs[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("OCRs an image with inline bytes and attaches ocrText", async () => {
    const extract = jest.fn(async () => ocrResult("INVOICE 42"))
    const segs = [imageSeg({ dataBase64: "AAAA", mimeType: "image/jpeg" })]
    await maybeOcrInboundSegments(segs, deps({ extract }))
    expect((segs[0] as { ocrText?: string }).ocrText).toBe("INVOICE 42")
    expect(extract).toHaveBeenCalledWith(
      {
        source: {
          kind: "data-url",
          dataUrl: "data:image/jpeg;base64,AAAA",
          mimeType: "image/jpeg",
        },
      },
      expect.anything()
    )
  })

  it("skips images that carry no inline bytes", async () => {
    const extract = jest.fn(async () => ocrResult("X"))
    const segs = [imageSeg()]
    await maybeOcrInboundSegments(segs, deps({ extract }))
    expect(extract).not.toHaveBeenCalled()
    expect((segs[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("does not re-OCR a segment that already has ocrText", async () => {
    const extract = jest.fn(async () => ocrResult("X"))
    const segs = [imageSeg({ dataBase64: "AAAA", ocrText: "kept" })]
    await maybeOcrInboundSegments(segs, deps({ extract }))
    expect(extract).not.toHaveBeenCalled()
    expect((segs[0] as { ocrText?: string }).ocrText).toBe("kept")
  })

  it("leaves the segment untouched when extraction throws (non-fatal)", async () => {
    const extract = jest.fn(async () => {
      throw new Error("provider down")
    })
    const segs = [imageSeg({ dataBase64: "AAAA" })]
    await expect(maybeOcrInboundSegments(segs, deps({ extract }))).resolves.toBeUndefined()
    expect((segs[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("fires the onError sink when extraction throws", async () => {
    const extract = jest.fn(async () => {
      throw new Error("provider down")
    })
    const onError = jest.fn()
    const segs = [imageSeg({ dataBase64: "AAAA" })]
    await maybeOcrInboundSegments(segs, deps({ extract, onError }))
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as { error: unknown }).error).toBeInstanceOf(Error)
  })

  it("ignores blank OCR output and non-image segments", async () => {
    const extract = jest.fn(async () => ocrResult("   "))
    const segs: MessageSegment[] = [{ type: "text", text: "hi" }, imageSeg({ dataBase64: "AAAA" })]
    await maybeOcrInboundSegments(segs, deps({ extract }))
    expect((segs[1] as { ocrText?: string }).ocrText).toBeUndefined()
    expect(extract).toHaveBeenCalledTimes(1)
  })
})

describe("runInboundOcr (production wrapper)", () => {
  beforeEach(() => {
    extractMock.mockReset().mockResolvedValue(ocrResult("FROM SETTINGS"))
    getSettingsMock.mockReset()
  })

  it("runs OCR when settings enable inbound images", async () => {
    getSettingsMock.mockResolvedValue({ ocrSettings: { ocrInboundImages: true } })
    const event = { segments: [imageSeg({ dataBase64: "AAAA" })] }
    await runInboundOcr(event)
    expect((event.segments[0] as { ocrText?: string }).ocrText).toBe("FROM SETTINGS")
  })

  it("skips OCR when inbound images are disabled in settings", async () => {
    getSettingsMock.mockResolvedValue({ ocrSettings: { ocrInboundImages: false } })
    const event = { segments: [imageSeg({ dataBase64: "AAAA" })] }
    await runInboundOcr(event)
    expect(extractMock).not.toHaveBeenCalled()
  })

  it("defaults to enabled when settings can't be read", async () => {
    getSettingsMock.mockRejectedValue(new Error("no dexie"))
    const event = { segments: [imageSeg({ dataBase64: "AAAA" })] }
    await runInboundOcr(event)
    expect(extractMock).toHaveBeenCalledTimes(1)
  })

  it("audits inbound.ocr_failed when extraction throws and adapterId is present", async () => {
    getSettingsMock.mockResolvedValue({ ocrSettings: { ocrInboundImages: true } })
    extractMock.mockReset().mockRejectedValue(new Error("provider down"))
    appendAuditMock.mockClear()
    const event = {
      segments: [imageSeg({ dataBase64: "AAAA" })],
      adapterId: "tg",
      conversationKey: "telegram:tg:1",
    }
    await runInboundOcr(event)
    expect(appendAuditMock).toHaveBeenCalledTimes(1)
    const entry = appendAuditMock.mock.calls[0][0] as { kind: string; adapterId: string }
    expect(entry.kind).toBe("inbound.ocr_failed")
    expect(entry.adapterId).toBe("tg")
  })

  it("does not audit when no adapterId is present (legacy narrow event)", async () => {
    getSettingsMock.mockResolvedValue({ ocrSettings: { ocrInboundImages: true } })
    extractMock.mockReset().mockRejectedValue(new Error("provider down"))
    appendAuditMock.mockClear()
    await runInboundOcr({ segments: [imageSeg({ dataBase64: "AAAA" })] })
    expect(appendAuditMock).not.toHaveBeenCalled()
  })
})
