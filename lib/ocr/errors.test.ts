import { DEFAULT_OCR_SETTINGS } from "@/types/ocr"
import { OcrError } from "@/lib/ocr/errors"

describe("OcrError", () => {
  it("carries code and provider id", () => {
    const err = new OcrError("missing_credentials", "mistral-ocr", "no key")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("OcrError")
    expect(err.code).toBe("missing_credentials")
    expect(err.providerId).toBe("mistral-ocr")
    expect(err.message).toBe("no key")
    expect(err.cause).toBeUndefined()
  })

  it("preserves a wrapped cause", () => {
    const original = new TypeError("inner")
    const err = new OcrError("provider_failed", "google-vision", "wrap", original)
    expect(err.cause).toBe(original)
  })
})

describe("DEFAULT_OCR_SETTINGS", () => {
  it("enables auto-router with a cloud fallback by default", () => {
    expect(DEFAULT_OCR_SETTINGS.defaultProviderId).toBe("auto")
    expect(DEFAULT_OCR_SETTINGS.cloudFallbackEnabled).toBe(true)
    expect(DEFAULT_OCR_SETTINGS.cloudFallbackProviderId).toBe("mistral-ocr")
  })

  it("turns on the PDF text-layer fast-path by default", () => {
    expect(DEFAULT_OCR_SETTINGS.pdfTextLayerFastPath).toBe(true)
  })

  it("uses markdown output and a 2000px long-edge cap by default", () => {
    expect(DEFAULT_OCR_SETTINGS.defaultFormat).toBe("markdown")
    expect(DEFAULT_OCR_SETTINGS.maxImageDimension).toBe(2000)
  })

  it("ships empty per-provider config and enabled maps", () => {
    expect(DEFAULT_OCR_SETTINGS.providerConfig).toEqual({})
    expect(DEFAULT_OCR_SETTINGS.providerEnabled).toEqual({})
  })

  it("retains caches for 30 days by default", () => {
    expect(DEFAULT_OCR_SETTINGS.cacheTtlDays).toBe(30)
  })
})
