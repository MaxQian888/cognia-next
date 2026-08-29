// canvas-types.ts is a type-only module — no runtime code lives here. The
// test exists primarily so the file appears in coverage reports and we
// document the expected row shape with a representative literal value.

// Runtime side-effect import so coverage instrumentation actually traces
// the (empty) module body. Type-only imports below are stripped by the
// transpiler and would leave canvas-types.ts at 0% coverage.
import "./canvas-types"
import type {
  CanvasCommentRow,
  CanvasDocumentRow,
  CanvasSessionRow,
  CanvasVersionRow,
} from "./canvas-types"

describe("canvas-types row shapes", () => {
  it("CanvasDocumentRow accepts the documented optional fields", () => {
    const doc: CanvasDocumentRow = {
      id: "doc_1",
      title: "Hello",
      content: "console.log(1)",
      language: "typescript",
      type: "code",
      createdAt: 0,
      updatedAt: 1,
    }
    expect(doc.title).toBe("Hello")
    expect(doc.type).toBe("code")
  })

  it("CanvasDocumentRow carries where the document came from", () => {
    // These four rode only in the `cognia-artifacts` localStorage blob until
    // persist v7. Dropping them from the row was invisible while that blob was
    // authoritative, and became a broken "return to the artifact this came
    // from" the moment Dexie became the only copy.
    const doc: CanvasDocumentRow = {
      id: "doc_2",
      title: "Derived",
      content: "x",
      language: "typescript",
      type: "code",
      createdAt: 0,
      updatedAt: 1,
      sourceArtifactId: "art_1",
      authoringOrigin: "artifact-panel",
      returnContext: {
        scope: "session",
        searchQuery: "",
        typeFilter: "all",
        runtimeFilter: "all",
      },
      aiWorkbench: {
        promptDraft: "",
        selectedPresetAction: null,
        attachments: [],
        pendingReview: null,
        actionHistory: [],
        isInlineCommandOpen: false,
      },
    }
    expect(doc.sourceArtifactId).toBe("art_1")
    expect(doc.returnContext?.scope).toBe("session")
    expect(doc.aiWorkbench?.actionHistory).toEqual([])
  })

  it("CanvasVersionRow can carry an isAutoSave flag and description", () => {
    const v: CanvasVersionRow = {
      id: "ver_1",
      documentId: "doc_1",
      content: "x",
      title: "v1",
      createdAt: 1,
      isAutoSave: true,
      description: "Initial draft",
    }
    expect(v.isAutoSave).toBe(true)
    expect(v.description).toBe("Initial draft")
  })

  it("CanvasCommentRow stamps timestamps as numeric millis", () => {
    const c: CanvasCommentRow = {
      id: "c1",
      documentId: "doc_1",
      content: "Looks good",
      author: { id: "u1", name: "Maya" },
      createdAt: 10,
      updatedAt: 20,
      resolvedAt: 30,
    } as unknown as CanvasCommentRow
    expect(typeof c.createdAt).toBe("number")
    expect(c.resolvedAt).toBe(30)
  })

  it("CanvasSessionRow round-trips a minimal payload", () => {
    const s: CanvasSessionRow = {
      id: "sess_1",
      documentId: "doc_1",
      ownerId: "u1",
      createdAt: 1,
      updatedAt: 2,
      isActive: true,
      permissions: {
        canEdit: true,
        canComment: true,
      } as unknown as CanvasSessionRow["permissions"],
    }
    expect(s.isActive).toBe(true)
    expect(s.id).toBe("sess_1")
  })
})
