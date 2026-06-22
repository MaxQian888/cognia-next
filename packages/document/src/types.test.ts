import {
  DOCUMENT_TYPE_VALUES,
  KNOWLEDGE_FILE_TYPE_VALUES,
  type DocumentMetadata,
  type DocumentType,
  type KnowledgeFileType,
  type Project,
} from "./types"

describe("document package types", () => {
  it("keeps the local document type registry complete", () => {
    expect(DOCUMENT_TYPE_VALUES).toEqual([
      "markdown",
      "code",
      "text",
      "json",
      "pdf",
      "word",
      "excel",
      "csv",
      "html",
      "rtf",
      "epub",
      "presentation",
      "unknown",
    ])

    const type: DocumentType = "pdf"
    expect(DOCUMENT_TYPE_VALUES).toContain(type)
  })

  it("keeps knowledge-file types aligned with supported document outputs", () => {
    const fileType: KnowledgeFileType = "presentation"

    expect(KNOWLEDGE_FILE_TYPE_VALUES).toContain(fileType)
    expect(KNOWLEDGE_FILE_TYPE_VALUES).not.toContain("unknown")
  })

  it("models document metadata and minimal project context locally", () => {
    const metadata: DocumentMetadata = {
      size: 12,
      lineCount: 2,
      wordCount: 3,
      custom: true,
    }
    const project: Project = {
      id: "p1",
      name: "Project",
      knowledgeBase: [],
    }

    expect(metadata.custom).toBe(true)
    expect(project.name).toBe("Project")
  })
})
