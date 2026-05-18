import {
  OCR_PARAMETER_SCHEMAS,
  applyOcrParameterDefaults,
  getOcrParameterSchema,
} from "./ocr-parameter-schemas"

describe("OCR_PARAMETER_SCHEMAS", () => {
  it("covers every provider id from the plan", () => {
    expect(Object.keys(OCR_PARAMETER_SCHEMAS).sort()).toEqual(
      [
        "abbyy-cloud",
        "anthropic-vision",
        "apple-vision",
        "aws-textract",
        "azure-document-intelligence",
        "gemini-vision",
        "google-vision",
        "lark-basic",
        "mathpix",
        "mistral-ocr",
        "mlkit-android",
        "nanonets",
        "ocr-space",
        "openai-vision",
        "tesseract-native",
        "tesseract-wasm",
        "windows-media-ocr",
      ].sort()
    )
  })

  it("attaches the common parameter block to every provider", () => {
    for (const schema of Object.values(OCR_PARAMETER_SCHEMAS)) {
      const keys = schema.parameters.map((p) => p.key)
      expect(keys).toContain("languages")
      expect(keys).toContain("format")
      expect(keys).toContain("pageRange")
      expect(keys).toContain("maxImageDimension")
    }
  })

  it("AWS Textract carries tables + forms toggles", () => {
    const aws = OCR_PARAMETER_SCHEMAS["aws-textract"]!
    const keys = aws.parameters.map((p) => p.key)
    expect(keys).toContain("region")
    expect(keys).toContain("enableTables")
    expect(keys).toContain("enableForms")
  })

  it("LLM-vision providers carry a prompt template", () => {
    for (const id of ["anthropic-vision", "openai-vision", "gemini-vision"] as const) {
      const schema = OCR_PARAMETER_SCHEMAS[id]!
      const keys = schema.parameters.map((p) => p.key)
      expect(keys).toContain("promptTemplate")
      expect(keys).toContain("model")
    }
  })
})

describe("getOcrParameterSchema", () => {
  it("returns the schema for a known id", () => {
    expect(getOcrParameterSchema("mistral-ocr")).toBe(OCR_PARAMETER_SCHEMAS["mistral-ocr"])
  })

  it("returns null for unknown ids", () => {
    expect(getOcrParameterSchema("unknown-provider")).toBeNull()
  })
})

describe("applyOcrParameterDefaults", () => {
  it("fills missing keys with their declared defaults", () => {
    const out = applyOcrParameterDefaults("mistral-ocr", {})
    expect(out.format).toBe("markdown")
    expect(out.languages).toBe("en")
    expect(out.maxImageDimension).toBe(2000)
    expect(out.model).toBe("mistral-ocr-2509")
  })

  it("preserves caller-supplied overrides", () => {
    const out = applyOcrParameterDefaults("mistral-ocr", { format: "blocks", model: "custom" })
    expect(out.format).toBe("blocks")
    expect(out.model).toBe("custom")
  })

  it("returns the input verbatim (cloned) when the schema is unknown", () => {
    const input = { foo: "bar" }
    const out = applyOcrParameterDefaults("unknown", input)
    expect(out).toEqual(input)
    expect(out).not.toBe(input)
  })
})
