import {
  canvasArtifactType,
  canvasDocumentToArtifact,
  isCanvasDocumentPreviewable,
} from "./artifact-projection"
import type { ArtifactLanguage, CanvasDocument } from "@/types/artifact/artifact"

function makeDoc(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  const now = new Date("2026-07-07T00:00:00.000Z")
  return {
    id: "doc-1",
    sessionId: "sess-1",
    projectId: "proj-1",
    title: "Untitled",
    content: "# Hello",
    language: "markdown",
    type: "text",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("canvasArtifactType", () => {
  it.each<[ArtifactLanguage, "code" | "text", string | null]>([
    ["html", "code", "html"],
    ["svg", "code", "svg"],
    ["jsx", "code", "react"],
    ["tsx", "code", "react"],
    ["mermaid", "code", "mermaid"],
    ["latex", "code", "math"],
    ["markdown", "text", "document"],
    ["markdown", "code", "document"],
  ])("maps %s/%s → %s", (language, type, expected) => {
    expect(canvasArtifactType({ language, type })).toBe(expected)
  })

  it.each<ArtifactLanguage>([
    "javascript",
    "typescript",
    "python",
    "plaintext",
    "css",
    "json",
    "sql",
    "bash",
    "yaml",
    "xml",
  ])("returns null for non-visual code language %s", (language) => {
    expect(canvasArtifactType({ language, type: "code" })).toBeNull()
  })

  it("treats any text document as a renderable document", () => {
    expect(canvasArtifactType({ language: "plaintext", type: "text" })).toBe("document")
  })
})

describe("isCanvasDocumentPreviewable", () => {
  it("is true for previewable languages", () => {
    expect(isCanvasDocumentPreviewable({ language: "html", type: "code" })).toBe(true)
  })

  it("is false for plain code", () => {
    expect(isCanvasDocumentPreviewable({ language: "python", type: "code" })).toBe(false)
  })
})

describe("canvasDocumentToArtifact", () => {
  it("returns null for non-previewable documents", () => {
    expect(canvasDocumentToArtifact(makeDoc({ language: "python", type: "code" }))).toBeNull()
  })

  it("projects a markdown document to a document artifact", () => {
    const artifact = canvasDocumentToArtifact(makeDoc())
    expect(artifact).not.toBeNull()
    expect(artifact).toMatchObject({
      id: "doc-1",
      sessionId: "sess-1",
      projectId: "proj-1",
      type: "document",
      title: "Untitled",
      content: "# Hello",
      language: "markdown",
      version: 1,
    })
  })

  it("carries a synthetic messageId and sandbox metadata", () => {
    const artifact = canvasDocumentToArtifact(
      makeDoc({ id: "abc", language: "html", type: "code" })
    )
    expect(artifact?.messageId).toBe("canvas:abc")
    expect(artifact?.type).toBe("html")
    expect(artifact?.metadata).toEqual({ previewable: true, sandboxed: true })
  })

  it("preserves original timestamps", () => {
    const doc = makeDoc({ language: "svg", type: "code" })
    const artifact = canvasDocumentToArtifact(doc)
    expect(artifact?.createdAt).toBe(doc.createdAt)
    expect(artifact?.updatedAt).toBe(doc.updatedAt)
  })
})
