import { OUTPUT_STYLE_IDS, isOutputStyleId, resolveOutputStyleSnippet } from "./output-styles"

describe("isOutputStyleId", () => {
  it("accepts every declared id", () => {
    for (const id of OUTPUT_STYLE_IDS) expect(isOutputStyleId(id)).toBe(true)
  })

  it("rejects unknown values and non-strings", () => {
    expect(isOutputStyleId("nope")).toBe(false)
    expect(isOutputStyleId(undefined)).toBe(false)
    expect(isOutputStyleId(42)).toBe(false)
  })
})

describe("resolveOutputStyleSnippet", () => {
  it("returns empty for default / undefined", () => {
    expect(resolveOutputStyleSnippet(undefined)).toBe("")
    expect(resolveOutputStyleSnippet("default")).toBe("")
  })

  it("returns the preset snippet for a known style", () => {
    expect(resolveOutputStyleSnippet("detailed")).toMatch(/Detailed/)
    expect(resolveOutputStyleSnippet("bullets")).toMatch(/Bullet points/)
    expect(resolveOutputStyleSnippet("teacher")).toMatch(/Explanatory/)
  })

  it("returns empty for an unknown style id", () => {
    expect(resolveOutputStyleSnippet("rainbow")).toBe("")
  })

  it("uses the custom instruction for the custom style", () => {
    expect(resolveOutputStyleSnippet("custom", "Answer in haiku.")).toBe(
      "Output style — Custom: Answer in haiku."
    )
  })

  it("returns empty for a custom style with a blank instruction", () => {
    expect(resolveOutputStyleSnippet("custom", "   ")).toBe("")
    expect(resolveOutputStyleSnippet("custom")).toBe("")
  })
})
