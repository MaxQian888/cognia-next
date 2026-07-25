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
        "local-http",
        "mathpix",
        "mistral-ocr",
        "mlkit-android",
        "nanonets",
        "ocr-space",
        "ocrs",
        "openai-vision",
        "paddle-ocr",
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

  it("uses current production defaults for managed OCR models", () => {
    expect(
      OCR_PARAMETER_SCHEMAS["anthropic-vision"]?.parameters.find((p) => p.key === "model")
        ?.defaultValue
    ).toBe("claude-sonnet-5")
    expect(
      OCR_PARAMETER_SCHEMAS["gemini-vision"]?.parameters.find((p) => p.key === "model")
        ?.defaultValue
    ).toBe("gemini-3.6-flash")
  })

  it("ocrs ships only the common parameter block", () => {
    const schema = OCR_PARAMETER_SCHEMAS["ocrs"]!
    const keys = schema.parameters.map((p) => p.key).sort()
    expect(keys).toEqual(["format", "languages", "maxImageDimension", "pageRange"])
  })

  it("paddle-ocr ships only the common parameter block (no dead model knob)", () => {
    const schema = OCR_PARAMETER_SCHEMAS["paddle-ocr"]!
    const keys = schema.parameters.map((p) => p.key).sort()
    expect(keys).toEqual(["format", "languages", "maxImageDimension", "pageRange"])
  })

  it("ocr-space exposes the engine selector the provider reads", () => {
    const schema = OCR_PARAMETER_SCHEMAS["ocr-space"]!
    const params = Object.fromEntries(schema.parameters.map((p) => [p.key, p]))
    expect(params["model"]).toBeUndefined()
    const engine = params["engine"]!
    expect(engine.type).toBe("select")
    expect(engine.defaultValue).toBe("3")
    expect(engine.validation?.options?.map((o) => o.value)).toEqual(["1", "2", "3"])
  })

  it("abbyy-cloud exposes the exportFormat selector the provider reads", () => {
    const schema = OCR_PARAMETER_SCHEMAS["abbyy-cloud"]!
    const params = Object.fromEntries(schema.parameters.map((p) => [p.key, p]))
    expect(params["model"]).toBeUndefined()
    const exportFormat = params["exportFormat"]!
    expect(exportFormat.type).toBe("select")
    expect(exportFormat.defaultValue).toBe("txt")
  })

  it("mathpix ships only the common parameter block (v3/text has no model)", () => {
    const schema = OCR_PARAMETER_SCHEMAS["mathpix"]!
    const keys = schema.parameters.map((p) => p.key).sort()
    expect(keys).toEqual(["format", "languages", "maxImageDimension", "pageRange"])
  })

  it("local-http requires endpoint + dialect and offers an optional apiKey + timeout", () => {
    const schema = OCR_PARAMETER_SCHEMAS["local-http"]!
    const params = Object.fromEntries(schema.parameters.map((p) => [p.key, p]))
    expect(params["endpoint"]).toBeDefined()
    expect(params["dialect"]).toBeDefined()
    expect(params["apiKey"]).toBeDefined()
    expect(params["timeoutMs"]).toBeDefined()
    const dialect = params["dialect"]!
    expect(dialect.type).toBe("select")
    const optionValues = dialect.validation?.options?.map((o) => o.value).sort() ?? []
    expect(optionValues).toEqual(["paddleocr-server", "umi-ocr"])
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
    expect(out.model).toBe("mistral-ocr-4-0")
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
