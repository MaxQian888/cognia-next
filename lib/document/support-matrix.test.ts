import {
  detectDocumentTypeFromFilename,
  getDocumentAcceptString,
  getDocumentFormatSummary,
  isBinaryFilename,
} from "./support-matrix"

describe("support-matrix", () => {
  it("maps new office-family extensions to canonical document categories", () => {
    expect(detectDocumentTypeFromFilename("template.docm")).toBe("word")
    expect(detectDocumentTypeFromFilename("notes.odt")).toBe("word")
    expect(detectDocumentTypeFromFilename("financials.xlsm")).toBe("excel")
    expect(detectDocumentTypeFromFilename("budget.ods")).toBe("excel")
    expect(detectDocumentTypeFromFilename("slides.pptm")).toBe("presentation")
    expect(detectDocumentTypeFromFilename("roadmap.odp")).toBe("presentation")
  })

  it("exposes vector accept string from the shared registry", () => {
    expect(getDocumentAcceptString("vector")).toBe(
      ".txt,.md,.json,.csv,.xml,.html,.htm,.pdf,.docx,.doc,.docm,.odt,.xlsx,.xls,.xlsm,.ods,.pptx,.ppt,.pptm,.odp,.rtf,.epub"
    )
  })

  it("exposes project knowledge-base accept string from the shared registry", () => {
    expect(getDocumentAcceptString("knowledge-base")).toContain(".odt")
    expect(getDocumentAcceptString("knowledge-base")).toContain(".xlsm")
    expect(getDocumentAcceptString("knowledge-base")).toContain(".pptm")
  })

  it("exposes curated ppt material support from the shared registry", () => {
    expect(getDocumentAcceptString("ppt-material")).toBe(
      ".txt,.md,.pdf,.docx,.docm,.odt,.rtf,.epub,.pptx,.pptm,.odp"
    )
  })

  it("reports binary status for new archive-backed formats", () => {
    expect(isBinaryFilename("notes.odt")).toBe(true)
    expect(isBinaryFilename("budget.ods")).toBe(true)
    expect(isBinaryFilename("slides.pptm")).toBe(true)
    expect(isBinaryFilename("notes.rtf")).toBe(false)
  })

  it("produces human-readable format summaries for UI copy", () => {
    expect(getDocumentFormatSummary("vector")).toContain(".odt")
    expect(getDocumentFormatSummary("ppt-material")).toContain(".epub")
  })
})
