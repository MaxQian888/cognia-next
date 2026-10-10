import { documentDraftOf, hasDocumentDraft, type FilesDocumentSources } from "./document-draft"

const sources: FilesDocumentSources = {
  canvasDocuments: { c1: { content: "# Doc", language: "markdown", type: "text" } },
  artifacts: {
    prose: { content: "Notes", type: "document" },
    code: { content: "x = 1", type: "code", language: "python" },
    bare: { content: "<svg/>", type: "svg" },
  },
}

describe("documentDraftOf", () => {
  it("reads a canvas document as it is", () => {
    expect(documentDraftOf({ kind: "canvas", sourceId: "c1" }, sources)).toEqual({
      content: "# Doc",
      language: "markdown",
      type: "text",
    })
  })

  it("reads prose artifacts as Markdown text and others as code", () => {
    expect(documentDraftOf({ kind: "artifact", sourceId: "prose" }, sources)).toEqual({
      content: "Notes",
      language: "markdown",
      type: "text",
    })
    expect(documentDraftOf({ kind: "artifact", sourceId: "code" }, sources)).toMatchObject({
      language: "python",
      type: "code",
    })
    expect(documentDraftOf({ kind: "artifact", sourceId: "bare" }, sources)).toMatchObject({
      language: "plaintext",
      type: "code",
    })
  })

  it("has nothing for a gone source or a non-document kind", () => {
    expect(documentDraftOf({ kind: "canvas", sourceId: "gone" }, sources)).toBeNull()
    expect(documentDraftOf({ kind: "artifact", sourceId: "gone" }, sources)).toBeNull()
    expect(documentDraftOf({ kind: "upload", sourceId: "u" }, sources)).toBeNull()
  })

  it("names the kinds that carry text", () => {
    expect(hasDocumentDraft({ kind: "canvas" })).toBe(true)
    expect(hasDocumentDraft({ kind: "artifact" })).toBe(true)
    expect(hasDocumentDraft({ kind: "image" })).toBe(false)
    expect(hasDocumentDraft({ kind: "session-upload" })).toBe(false)
  })
})
