import {
  CANVAS_LANGUAGE_OPTIONS,
  CANVAS_TEXT_LANGUAGES,
  canvasLanguageLabel,
  canvasTypeForLanguage,
} from "./languages"
import type { ArtifactLanguage } from "@/types/artifact/artifact"

describe("canvasTypeForLanguage", () => {
  it("maps prose languages to text", () => {
    expect(canvasTypeForLanguage("markdown")).toBe("text")
    expect(canvasTypeForLanguage("plaintext")).toBe("text")
  })

  it.each<ArtifactLanguage>([
    "javascript",
    "typescript",
    "python",
    "html",
    "svg",
    "mermaid",
    "json",
  ])("maps %s to code", (language) => {
    expect(canvasTypeForLanguage(language)).toBe("code")
  })

  it("keeps CANVAS_TEXT_LANGUAGES and the type mapping in sync", () => {
    for (const { value } of CANVAS_LANGUAGE_OPTIONS) {
      const expected = CANVAS_TEXT_LANGUAGES.has(value) ? "text" : "code"
      expect(canvasTypeForLanguage(value)).toBe(expected)
    }
  })
})

describe("CANVAS_LANGUAGE_OPTIONS", () => {
  it("has unique values and non-empty labels", () => {
    const values = CANVAS_LANGUAGE_OPTIONS.map((o) => o.value)
    expect(new Set(values).size).toBe(values.length)
    expect(CANVAS_LANGUAGE_OPTIONS.every((o) => o.label.length > 0)).toBe(true)
  })

  it("lists the text languages first", () => {
    expect(CANVAS_LANGUAGE_OPTIONS[0].value).toBe("markdown")
    expect(CANVAS_LANGUAGE_OPTIONS[1].value).toBe("plaintext")
  })
})

describe("canvasLanguageLabel", () => {
  it("returns the human label for a known language", () => {
    expect(canvasLanguageLabel("typescript")).toBe("TypeScript")
    expect(canvasLanguageLabel("markdown")).toBe("Markdown")
  })

  it("falls back to the raw value for an unlisted language", () => {
    expect(canvasLanguageLabel("cobol" as ArtifactLanguage)).toBe("cobol")
  })
})
