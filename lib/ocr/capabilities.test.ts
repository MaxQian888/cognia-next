import {
  CAPABILITY_PROVIDER_IDS,
  OCR_PROVIDER_CAPABILITIES,
  estimateOcrCost,
  topSidebarCapabilities,
} from "./capabilities"

// The settings UI re-declares its own provider registry in
// `components/settings/ocr/ocr-section.tsx` (see the comment there explaining
// why). This test pins parity against the engine-side runtime registry so a
// new provider can't slip through without a capability row.
const REGISTRY_PROVIDER_IDS = [
  "mistral-ocr",
  "google-vision",
  "aws-textract",
  "azure-document-intelligence",
  "anthropic-vision",
  "openai-vision",
  "gemini-vision",
  "mathpix",
  "ocr-space",
  "abbyy-cloud",
  "nanonets",
  "lark-basic",
  "tesseract-wasm",
  "tesseract-native",
  "windows-media-ocr",
  "apple-vision",
  "mlkit-android",
  "ocrs",
  "paddle-ocr",
  "local-http",
] as const

describe("OCR_PROVIDER_CAPABILITIES", () => {
  it("covers every shipped provider", () => {
    for (const id of REGISTRY_PROVIDER_IDS) {
      expect(OCR_PROVIDER_CAPABILITIES[id]).toBeDefined()
    }
    expect(CAPABILITY_PROVIDER_IDS).toEqual(expect.arrayContaining([...REGISTRY_PROVIDER_IDS]))
  })

  it("uses only allowed capability values", () => {
    for (const [id, caps] of Object.entries(OCR_PROVIDER_CAPABILITIES)) {
      for (const field of [
        "handwriting",
        "tables",
        "math",
        "cjk",
        "layout",
        "offline",
        "structuredOutput",
        "pdfNative",
      ] as const) {
        expect(["yes", "no", "partial"]).toContain(caps[field])
      }
      expect(["free", "$", "$$", "$$$"]).toContain(caps.costTier)
      expect(typeof caps.multilang).toBe("number")
      expect(caps.multilang).toBeGreaterThan(0)
      expect(caps.maxPagesPerCall === null || typeof caps.maxPagesPerCall === "number").toBe(true)
      // Category mirrors the registry category — local engines must be tagged
      // local so the matrix and sidebar grouping stay in sync.
      if (id.startsWith("tesseract") || id === "ocrs" || id === "paddle-ocr") {
        expect(caps.category).toBe("local")
      }
    }
  })

  it("pins known spot-checks", () => {
    expect(OCR_PROVIDER_CAPABILITIES.mathpix.math).toBe("yes")
    expect(OCR_PROVIDER_CAPABILITIES["tesseract-wasm"].offline).toBe("yes")
    expect(OCR_PROVIDER_CAPABILITIES["paddle-ocr"].cjk).toBe("yes")
    expect(OCR_PROVIDER_CAPABILITIES["aws-textract"].tables).toBe("yes")
    expect(OCR_PROVIDER_CAPABILITIES["mistral-ocr"].costTier).toBe("$")
    expect(OCR_PROVIDER_CAPABILITIES["anthropic-vision"].pdfNative).toBe("no")
  })
})

describe("estimateOcrCost", () => {
  it("returns 0 for free engines", () => {
    expect(estimateOcrCost("tesseract-wasm", 5)).toBe(0)
    expect(estimateOcrCost("apple-vision", 100)).toBe(0)
  })

  it("scales linearly with pages", () => {
    const one = estimateOcrCost("mistral-ocr", 1)
    const ten = estimateOcrCost("mistral-ocr", 10)
    expect(ten).toBeCloseTo(one * 10, 4)
  })

  it("clamps fractional pages up to at least 1", () => {
    expect(estimateOcrCost("aws-textract", 0)).toBeCloseTo(estimateOcrCost("aws-textract", 1), 4)
    expect(estimateOcrCost("aws-textract", -3)).toBeCloseTo(estimateOcrCost("aws-textract", 1), 4)
  })

  it("returns 0 for unknown providers", () => {
    expect(estimateOcrCost("does-not-exist", 5)).toBe(0)
  })
})

describe("topSidebarCapabilities", () => {
  it("surfaces up to 3 distinguishing flags", () => {
    const caps = topSidebarCapabilities("mathpix")
    expect(caps.length).toBeLessThanOrEqual(3)
    expect(caps).toContain("math")
  })

  it("returns offline for a local engine", () => {
    expect(topSidebarCapabilities("tesseract-wasm")).toContain("offline")
  })

  it("returns empty list for unknown providers", () => {
    expect(topSidebarCapabilities("ghost")).toEqual([])
  })
})
