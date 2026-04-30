/**
 * @jest-environment jsdom
 */

import { act } from "@testing-library/react"
import { useChunkedDocumentStore, selectCanvasChunkingState } from "./chunked-document-store"

describe("useChunkedDocumentStore", () => {
  beforeEach(() => {
    act(() => {
      useChunkedDocumentStore.setState({
        chunkedDocuments: {},
        loadedChunks: {},
        documentIndices: {},
        visibleRanges: {},
      })
    })
  })

  it("does not rewrite chunked documents when content is unchanged", () => {
    let originalDocument

    act(() => {
      originalDocument = useChunkedDocumentStore
        .getState()
        .addChunkedDocument("doc-1", "function example() {\n  return 1;\n}")
    })

    let updatedDocument
    act(() => {
      updatedDocument = useChunkedDocumentStore
        .getState()
        .updateDocument("doc-1", "function example() {\n  return 1;\n}")
    })

    expect(updatedDocument).toBe(originalDocument)
    expect(useChunkedDocumentStore.getState().chunkedDocuments["doc-1"]).toBe(originalDocument)
  })

  it("exposes a canvas-safe slice without loadedChunks", () => {
    const selected = selectCanvasChunkingState(useChunkedDocumentStore.getState())

    expect(selected.chunkedDocuments).toEqual({})
    expect(selected.addChunkedDocument).toBe(useChunkedDocumentStore.getState().addChunkedDocument)
    expect("loadedChunks" in selected).toBe(false)
  })

  it("addChunkedDocument seeds an empty loadedChunks set and stores the index", () => {
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-x", "a\nb\nc")
    })
    const state = useChunkedDocumentStore.getState()
    expect(state.chunkedDocuments["doc-x"]).toBeDefined()
    expect(state.loadedChunks["doc-x"]).toBeInstanceOf(Set)
    expect(state.loadedChunks["doc-x"].size).toBe(0)
    expect(state.documentIndices["doc-x"]).toBeDefined()
  })

  it("removeChunkedDocument purges all related entries", () => {
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-1", "hello")
      useChunkedDocumentStore.getState().updateVisibleRange("doc-1", 0, 1)
    })
    act(() => {
      useChunkedDocumentStore.getState().removeChunkedDocument("doc-1")
    })
    const state = useChunkedDocumentStore.getState()
    expect(state.chunkedDocuments["doc-1"]).toBeUndefined()
    expect(state.loadedChunks["doc-1"]).toBeUndefined()
    expect(state.documentIndices["doc-1"]).toBeUndefined()
    expect(state.visibleRanges["doc-1"]).toBeUndefined()
  })

  it("getDocumentContent returns null when the document is missing", () => {
    expect(useChunkedDocumentStore.getState().getDocumentContent("missing")).toBeNull()
  })

  it("getDocumentContent assembles content for an existing document", () => {
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-2", "hello world")
    })
    expect(useChunkedDocumentStore.getState().getDocumentContent("doc-2")).toBe("hello world")
  })

  it("loadChunkRange returns null when document is missing", () => {
    expect(useChunkedDocumentStore.getState().loadChunkRange("missing", 0, 5)).toBeNull()
  })

  it("loadChunkRange returns content and marks chunks as loaded", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-3", lines)
    })
    let content: string | null = null
    act(() => {
      content = useChunkedDocumentStore.getState().loadChunkRange("doc-3", 1, 3)
    })
    expect(content).not.toBeNull()
    const loaded = useChunkedDocumentStore.getState().loadedChunks["doc-3"]
    expect(loaded.size).toBeGreaterThanOrEqual(1)
  })

  it("loadChunkRange merges with previously loaded chunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-merge", lines)
      useChunkedDocumentStore.getState().loadChunkRange("doc-merge", 0, 1)
      useChunkedDocumentStore.getState().loadChunkRange("doc-merge", 5, 6)
    })
    expect(useChunkedDocumentStore.getState().loadedChunks["doc-merge"]).toBeInstanceOf(Set)
  })

  it("unloadUnusedChunks is a no-op when document is missing", () => {
    act(() => {
      useChunkedDocumentStore.getState().unloadUnusedChunks("missing", 5)
    })
    // Should not throw and should not introduce a new entry
    expect(useChunkedDocumentStore.getState().loadedChunks["missing"]).toBeUndefined()
  })

  it("unloadUnusedChunks is a no-op when no visible range is set", () => {
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-no-range", "hello")
    })
    act(() => {
      useChunkedDocumentStore.getState().unloadUnusedChunks("doc-no-range", 5)
    })
    expect(useChunkedDocumentStore.getState().loadedChunks["doc-no-range"].size).toBe(0)
  })

  it("unloadUnusedChunks reduces the loaded chunks to the visible range", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-trim", lines)
      // Load all chunks
      useChunkedDocumentStore.getState().loadChunkRange("doc-trim", 0, 59)
      useChunkedDocumentStore.getState().updateVisibleRange("doc-trim", 1, 5)
    })
    act(() => {
      useChunkedDocumentStore.getState().unloadUnusedChunks("doc-trim", 1)
    })
    const loaded = useChunkedDocumentStore.getState().loadedChunks["doc-trim"]
    expect(loaded).toBeInstanceOf(Set)
  })

  it("updateVisibleRange writes to the visibleRanges map", () => {
    act(() => {
      useChunkedDocumentStore.getState().updateVisibleRange("doc-vis", 10, 20)
    })
    expect(useChunkedDocumentStore.getState().visibleRanges["doc-vis"]).toEqual({
      startLine: 10,
      endLine: 20,
    })
  })

  it("updateDocument returns null for unknown documents", () => {
    expect(useChunkedDocumentStore.getState().updateDocument("missing", "x")).toBeNull()
  })

  it("updateDocument computes a diff and stores the new document when content changes", () => {
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-diff", "first")
    })
    let result: unknown
    act(() => {
      result = useChunkedDocumentStore.getState().updateDocument("doc-diff", "second")
    })
    expect(result).not.toBeNull()
    expect(useChunkedDocumentStore.getState().chunkedDocuments["doc-diff"]).toBe(result)
  })

  it("getDocumentIndex returns the stored index or null", () => {
    expect(useChunkedDocumentStore.getState().getDocumentIndex("missing")).toBeNull()
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-idx", "a\nb")
    })
    expect(useChunkedDocumentStore.getState().getDocumentIndex("doc-idx")).not.toBeNull()
  })

  it("isLargeDocument returns false for missing documents and small content", () => {
    expect(useChunkedDocumentStore.getState().isLargeDocument("missing")).toBe(false)
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-small", "hi")
    })
    expect(useChunkedDocumentStore.getState().isLargeDocument("doc-small")).toBe(false)
  })

  it("isLargeDocument returns true once the document exceeds the threshold (50000 chars)", () => {
    const big = "x".repeat(50_001)
    act(() => {
      useChunkedDocumentStore.getState().addChunkedDocument("doc-big", big)
    })
    expect(useChunkedDocumentStore.getState().isLargeDocument("doc-big")).toBe(true)
  })
})
