/**
 * Tests for RTF Parser
 */

import { parseRTF, extractRTFEmbeddableContent } from "./rtf-parser"

describe("parseRTF", () => {
  it("extracts plain text from basic rtf", () => {
    const input = "{\\rtf1\\ansi\\deff0\\pard Hello\\par World\\par}"
    const result = parseRTF(input)

    expect(result.text).toContain("Hello")
    expect(result.text).toContain("World")
    expect(result.metadata.controlWordCount).toBeGreaterThan(0)
  })

  it("decodes unicode and hex escapes", () => {
    const input = "{\\rtf1\\ansi\\ansicpg1252\\pard Caf\\'e9 \\u20320?\\par}"
    const result = parseRTF(input)

    expect(result.text).toContain("Café")
    expect(result.text).toContain("你")
    expect(result.metadata.charset).toBe("windows-1252")
  })

  it("throws when no readable text can be extracted", () => {
    const input = "{\\rtf1\\ansi\\b\\i\\ul\\par}"
    expect(() => parseRTF(input)).toThrow("No readable text content found")
  })
})

describe("extractRTFEmbeddableContent", () => {
  it("returns extracted text", () => {
    const result = parseRTF("{\\rtf1\\ansi\\pard Embeddable text\\par}")
    expect(extractRTFEmbeddableContent(result)).toBe(result.text)
  })
})
