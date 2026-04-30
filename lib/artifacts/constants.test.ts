import {
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_KEYS,
  ARTIFACT_I18N_TYPE_KEYS,
  ARTIFACT_EXTENSIONS,
  ARTIFACT_COLORS,
  LANGUAGE_MAP,
  SHIKI_LANGUAGE_MAP,
  MONACO_LANGUAGE_MAP,
  PREVIEWABLE_TYPES,
  DESIGNABLE_TYPES,
  ALWAYS_CREATE_TYPES,
  DETECTION_PATTERNS,
  MERMAID_TYPE_NAMES,
  LANGUAGE_DISPLAY_NAMES,
  CHART_COLORS,
  getArtifactExtension,
  mapToArtifactLanguage,
  getShikiLanguage,
  getMonacoLanguage,
  canPreview,
  canDesign,
  matchesTypePatterns,
  getLanguageDisplayName,
} from "./constants"

describe("artifact type tables", () => {
  it("registers exactly 9 artifact types in every map", () => {
    expect(ARTIFACT_TYPES).toHaveLength(9)
    for (const t of ARTIFACT_TYPES) {
      expect(ARTIFACT_EXTENSIONS).toHaveProperty(t)
      expect(ARTIFACT_COLORS).toHaveProperty(t)
      expect(ARTIFACT_TYPE_KEYS).toHaveProperty(t)
      expect(ARTIFACT_I18N_TYPE_KEYS).toHaveProperty(t)
    }
  })

  it("MERMAID_TYPE_NAMES + CHART_COLORS are non-empty", () => {
    expect(Object.keys(MERMAID_TYPE_NAMES).length).toBeGreaterThan(0)
    expect(CHART_COLORS.length).toBeGreaterThan(0)
  })
})

describe("getArtifactExtension", () => {
  it("returns the static ext for non-code types", () => {
    expect(getArtifactExtension("html")).toBe("html")
    expect(getArtifactExtension("svg")).toBe("svg")
    expect(getArtifactExtension("jupyter")).toBe("ipynb")
    expect(getArtifactExtension("document")).toBe("md")
    expect(getArtifactExtension("math")).toBe("tex")
    expect(getArtifactExtension("react")).toBe("tsx")
    expect(getArtifactExtension("mermaid")).toBe("mmd")
    expect(getArtifactExtension("chart")).toBe("json")
  })

  it("maps code language to language-specific ext", () => {
    expect(getArtifactExtension("code", "python")).toBe("py")
    expect(getArtifactExtension("code", "typescript")).toBe("ts")
    expect(getArtifactExtension("code", "tsx")).toBe("tsx")
  })

  it("falls back to txt for unknown code language", () => {
    expect(getArtifactExtension("code", "unknown-lang")).toBe("txt")
    expect(getArtifactExtension("code")).toBe("txt")
  })
})

describe("language helpers", () => {
  it("mapToArtifactLanguage normalizes aliases", () => {
    expect(mapToArtifactLanguage("js")).toBe("javascript")
    expect(mapToArtifactLanguage("PY")).toBe("python")
    expect(mapToArtifactLanguage("md")).toBe("markdown")
    expect(mapToArtifactLanguage()).toBeUndefined()
    expect(mapToArtifactLanguage("totally-bogus")).toBeUndefined()
  })

  it("getShikiLanguage returns 'text' for unknown", () => {
    expect(getShikiLanguage("javascript")).toBe("javascript")
    expect(getShikiLanguage()).toBe("text")
    expect(getShikiLanguage("nope")).toBe("text")
  })

  it("getMonacoLanguage returns 'plaintext' for unknown", () => {
    expect(getMonacoLanguage("typescript")).toBe("typescript")
    expect(getMonacoLanguage()).toBe("plaintext")
    expect(getMonacoLanguage("nope")).toBe("plaintext")
  })

  it("LANGUAGE_MAP, SHIKI_LANGUAGE_MAP, MONACO_LANGUAGE_MAP cover the canonical languages", () => {
    expect(LANGUAGE_MAP.python).toBe("python")
    expect(SHIKI_LANGUAGE_MAP.javascript).toBe("javascript")
    expect(MONACO_LANGUAGE_MAP.bash).toBe("shell")
  })

  it("getLanguageDisplayName falls back to title-cased value", () => {
    expect(getLanguageDisplayName("javascript")).toBe("JavaScript")
    expect(getLanguageDisplayName()).toBe("Code")
    expect(getLanguageDisplayName("klingon")).toBe("Klingon")
  })
})

describe("type predicates", () => {
  it("canPreview matches the previewable list", () => {
    for (const t of PREVIEWABLE_TYPES) expect(canPreview(t)).toBe(true)
    expect(canPreview("code")).toBe(false)
  })

  it("canDesign matches the designable list", () => {
    for (const t of DESIGNABLE_TYPES) expect(canDesign(t)).toBe(true)
    expect(canDesign("math")).toBe(false)
  })

  it("ALWAYS_CREATE_TYPES is a subset of all types", () => {
    for (const t of ALWAYS_CREATE_TYPES) {
      expect(ARTIFACT_TYPES).toContain(t)
    }
  })
})

describe("matchesTypePatterns", () => {
  it("identifies HTML by doctype", () => {
    expect(matchesTypePatterns("<!DOCTYPE html><html></html>", "html")).toBe(true)
  })

  it("identifies React by JSX usage", () => {
    expect(
      matchesTypePatterns("import React from 'react'\nfunction Foo(){return <div/>}", "react")
    ).toBe(true)
  })

  it("identifies SVG", () => {
    expect(matchesTypePatterns('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "svg")).toBe(true)
  })

  it("identifies Mermaid", () => {
    expect(matchesTypePatterns("graph TD\nA --> B", "mermaid")).toBe(true)
  })

  it("identifies Chart JSON", () => {
    expect(
      matchesTypePatterns('[{"name":"Jan","value":12},{"name":"Feb","value":18}]', "chart")
    ).toBe(true)
  })

  it("identifies math via display delimiter", () => {
    expect(matchesTypePatterns("$$\n\\frac{a}{b}\n$$", "math")).toBe(true)
  })

  it("identifies Jupyter by cells field", () => {
    expect(matchesTypePatterns('{"cells": [], "nbformat": 4}', "jupyter")).toBe(true)
  })

  it("returns false when no pattern matches", () => {
    expect(matchesTypePatterns("plain text", "html")).toBe(false)
  })
})

describe("DETECTION_PATTERNS keys", () => {
  it("includes the 7 detectable categories", () => {
    expect(Object.keys(DETECTION_PATTERNS).sort()).toEqual(
      ["chart", "html", "jupyter", "math", "mermaid", "react", "svg"].sort()
    )
  })
})

describe("LANGUAGE_DISPLAY_NAMES", () => {
  it("covers TypeScript / JavaScript / Python", () => {
    expect(LANGUAGE_DISPLAY_NAMES.typescript).toBe("TypeScript")
    expect(LANGUAGE_DISPLAY_NAMES.javascript).toBe("JavaScript")
    expect(LANGUAGE_DISPLAY_NAMES.python).toBe("Python")
  })
})
