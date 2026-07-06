import { defineOcrProvider } from "./define-ocr-provider"

describe("defineOcrProvider", () => {
  it("returns the OCR provider contribution unchanged", () => {
    const def = {
      id: "local-ocr",
      label: "Local OCR",
      entry: "ocr/local.ts",
      export: "createOcrProvider",
      languages: ["en", "zh-CN"],
    }

    expect(defineOcrProvider(def)).toBe(def)
  })
})
