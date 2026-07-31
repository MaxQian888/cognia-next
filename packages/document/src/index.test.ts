import {
  detectDocumentType,
  extractFirstTable,
  extractSummary,
  getFileExtension,
  inferKnowledgeFileTypeFromFilename,
} from "./index"

describe("document package barrel", () => {
  it("re-exports document processing helpers", () => {
    expect(getFileExtension("Report.PDF")).toBe("pdf")
    expect(detectDocumentType("notes.md")).toBe("markdown")
    expect(extractSummary("First sentence. Second sentence.", 20)).toBe("First sentence.")
  })

  it("re-exports support matrix and table helpers", () => {
    expect(inferKnowledgeFileTypeFromFilename("deck.pptx")).toBe("presentation")
    const table = extractFirstTable("| Name | Value |\n| --- | --- |\n| A | 1 |")
    expect(table?.headers).toEqual(["Name", "Value"])
  })
})
