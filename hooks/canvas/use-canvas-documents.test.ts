/**
 * Tests for useCanvasDocuments hook
 */

import { renderHook, act } from "@testing-library/react"
import { useCanvasDocuments } from "./use-canvas-documents"
import type { CanvasDocument, ArtifactLanguage } from "@/types"

// Mock stores
jest.mock("@/stores", () => ({
  useArtifactStore: jest.fn((selector) => {
    const state = {
      canvasDocuments: {},
      activeCanvasId: null,
      createCanvasDocument: jest.fn(),
      updateCanvasDocument: jest.fn(),
      deleteCanvasDocument: jest.fn(),
      setActiveCanvas: jest.fn(),
      openPanel: jest.fn(),
    }
    return selector(state)
  }),
}))

// Mock nanoid
jest.mock("nanoid", () => ({
  nanoid: jest.fn(() => "test-doc-id-123"),
}))

describe("useCanvasDocuments", () => {
  const mockCanvasDocuments: Record<string, CanvasDocument> = {
    "doc-1": {
      id: "doc-1",
      sessionId: "session-1",
      title: "Document 1",
      content: "Content 1",
      language: "typescript" as ArtifactLanguage,
      type: "code",
      createdAt: new Date("2024-01-15T10:00:00"),
      updatedAt: new Date("2024-01-15T10:30:00"),
    },
    "doc-2": {
      id: "doc-2",
      sessionId: "session-1",
      title: "Document 2",
      content: "Content 2",
      language: "python" as ArtifactLanguage,
      type: "code",
      createdAt: new Date("2024-01-15T09:00:00"),
      updatedAt: new Date("2024-01-15T09:30:00"),
    },
    "doc-3": {
      id: "doc-3",
      sessionId: "session-2",
      title: "Document 3",
      content: "Content 3",
      language: "markdown" as ArtifactLanguage,
      type: "text",
      createdAt: new Date("2024-01-15T11:00:00"),
      updatedAt: new Date("2024-01-15T11:30:00"),
    },
  }

  let mockCreateCanvasDocument: jest.Mock
  let mockUpdateCanvasDocument: jest.Mock
  let mockDeleteCanvasDocument: jest.Mock
  let mockSetActiveCanvas: jest.Mock
  let mockOpenPanel: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    mockCreateCanvasDocument = jest.fn().mockReturnValue("test-doc-id-123")
    mockUpdateCanvasDocument = jest.fn()
    mockDeleteCanvasDocument = jest.fn()
    mockSetActiveCanvas = jest.fn()
    mockOpenPanel = jest.fn()

    // Update store mock to return our mock functions
    ;(jest.requireMock("@/stores").useArtifactStore as jest.Mock).mockImplementation((selector) => {
      const state = {
        canvasDocuments: mockCanvasDocuments,
        activeCanvasId: null,
        createCanvasDocument: mockCreateCanvasDocument,
        updateCanvasDocument: mockUpdateCanvasDocument,
        deleteCanvasDocument: mockDeleteCanvasDocument,
        setActiveCanvas: mockSetActiveCanvas,
        openPanel: mockOpenPanel,
      }
      return selector(state)
    })
  })

  describe("initialization", () => {
    it("should initialize with documents sorted by updatedAt", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      expect(result.current.documents).toHaveLength(3)
      expect(result.current.documents[0].id).toBe("doc-3") // Most recent
      expect(result.current.documents[1].id).toBe("doc-1") // Middle
      expect(result.current.documents[2].id).toBe("doc-2") // Oldest
      expect(result.current.activeDocument).toBeNull()
      expect(result.current.activeDocumentId).toBeNull()
      expect(result.current.documentCount).toBe(3)
    })

    it("should return active document when activeCanvasId is set", () => {
      ;(jest.requireMock("@/stores").useArtifactStore as jest.Mock).mockImplementation(
        (selector) => {
          const state = {
            canvasDocuments: mockCanvasDocuments,
            activeCanvasId: "doc-1",
            createCanvasDocument: mockCreateCanvasDocument,
            updateCanvasDocument: mockUpdateCanvasDocument,
            deleteCanvasDocument: mockDeleteCanvasDocument,
            setActiveCanvas: mockSetActiveCanvas,
            openPanel: mockOpenPanel,
          }
          return selector(state)
        }
      )

      const { result } = renderHook(() => useCanvasDocuments())

      expect(result.current.activeDocument).toEqual(mockCanvasDocuments["doc-1"])
      expect(result.current.activeDocumentId).toBe("doc-1")
    })

    it("should handle empty documents", () => {
      ;(jest.requireMock("@/stores").useArtifactStore as jest.Mock).mockImplementation(
        (selector) => {
          const state = {
            canvasDocuments: {},
            activeCanvasId: null,
            createCanvasDocument: mockCreateCanvasDocument,
            updateCanvasDocument: mockUpdateCanvasDocument,
            deleteCanvasDocument: mockDeleteCanvasDocument,
            setActiveCanvas: mockSetActiveCanvas,
            openPanel: mockOpenPanel,
          }
          return selector(state)
        }
      )

      const { result } = renderHook(() => useCanvasDocuments())

      expect(result.current.documents).toEqual([])
      expect(result.current.documentCount).toBe(0)
    })
  })

  describe("createDocument", () => {
    it("should create a new document", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const options = {
        sessionId: "session-1",
        title: "New Document",
        content: "New content",
        language: "javascript" as ArtifactLanguage,
        type: "code" as const,
      }

      let docId
      act(() => {
        docId = result.current.createDocument(options)
      })

      expect(docId).toBe("test-doc-id-123")
      expect(mockCreateCanvasDocument).toHaveBeenCalledWith(options)
    })

    it("should create document without sessionId", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const options = {
        title: "New Document",
        content: "New content",
        language: "typescript" as ArtifactLanguage,
        type: "text" as const,
      }

      act(() => {
        result.current.createDocument(options)
      })

      expect(mockCreateCanvasDocument).toHaveBeenCalledWith(options)
    })
  })

  describe("openDocument", () => {
    it("should open existing document and set as active", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      act(() => {
        result.current.openDocument("doc-1")
      })

      expect(mockSetActiveCanvas).toHaveBeenCalledWith("doc-1")
      expect(mockOpenPanel).toHaveBeenCalledWith("canvas")
    })

    it("should not open non-existent document", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      act(() => {
        result.current.openDocument("non-existent")
      })

      expect(mockSetActiveCanvas).not.toHaveBeenCalled()
      expect(mockOpenPanel).not.toHaveBeenCalled()
    })
  })

  describe("closeDocument", () => {
    it("should close active document and switch to next available", () => {
      ;(jest.requireMock("@/stores").useArtifactStore as jest.Mock).mockImplementation(
        (selector) => {
          const state = {
            canvasDocuments: mockCanvasDocuments,
            activeCanvasId: "doc-1",
            createCanvasDocument: mockCreateCanvasDocument,
            updateCanvasDocument: mockUpdateCanvasDocument,
            deleteCanvasDocument: mockDeleteCanvasDocument,
            setActiveCanvas: mockSetActiveCanvas,
            openPanel: mockOpenPanel,
          }
          return selector(state)
        }
      )

      const { result } = renderHook(() => useCanvasDocuments())

      act(() => {
        result.current.closeDocument("doc-1")
      })

      expect(mockSetActiveCanvas).toHaveBeenCalledWith("doc-3") // Next most recent
    })

    it("should close active document and set null when no others available", () => {
      const singleDoc = { "doc-1": mockCanvasDocuments["doc-1"] }

      ;(jest.requireMock("@/stores").useArtifactStore as jest.Mock).mockImplementation(
        (selector) => {
          const state = {
            canvasDocuments: singleDoc,
            activeCanvasId: "doc-1",
            createCanvasDocument: mockCreateCanvasDocument,
            updateCanvasDocument: mockUpdateCanvasDocument,
            deleteCanvasDocument: mockDeleteCanvasDocument,
            setActiveCanvas: mockSetActiveCanvas,
            openPanel: mockOpenPanel,
          }
          return selector(state)
        }
      )

      const { result } = renderHook(() => useCanvasDocuments())

      act(() => {
        result.current.closeDocument("doc-1")
      })

      expect(mockSetActiveCanvas).toHaveBeenCalledWith(null)
    })

    it("should not close when document is not active", () => {
      ;(jest.requireMock("@/stores").useArtifactStore as jest.Mock).mockImplementation(
        (selector) => {
          const state = {
            canvasDocuments: mockCanvasDocuments,
            activeCanvasId: "doc-2",
            createCanvasDocument: mockCreateCanvasDocument,
            updateCanvasDocument: mockUpdateCanvasDocument,
            deleteCanvasDocument: mockDeleteCanvasDocument,
            setActiveCanvas: mockSetActiveCanvas,
            openPanel: mockOpenPanel,
          }
          return selector(state)
        }
      )

      const { result } = renderHook(() => useCanvasDocuments())

      act(() => {
        result.current.closeDocument("doc-1")
      })

      expect(mockSetActiveCanvas).not.toHaveBeenCalled()
    })
  })

  describe("deleteDocument", () => {
    it("should delete document and close it first", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      act(() => {
        result.current.deleteDocument("doc-1")
      })

      expect(mockDeleteCanvasDocument).toHaveBeenCalledWith("doc-1")
    })
  })

  describe("renameDocument", () => {
    it("should rename document", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      act(() => {
        result.current.renameDocument("doc-1", "New Title")
      })

      expect(mockUpdateCanvasDocument).toHaveBeenCalledWith("doc-1", { title: "New Title" })
    })
  })

  describe("duplicateDocument", () => {
    it("should duplicate existing document", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      let duplicatedId
      act(() => {
        duplicatedId = result.current.duplicateDocument("doc-1")
      })

      expect(duplicatedId).toBe("test-doc-id-123")
      expect(mockCreateCanvasDocument).toHaveBeenCalledWith({
        sessionId: "session-1",
        title: "Document 1 (Copy)",
        content: "Content 1",
        language: "typescript",
        type: "code",
      })
    })

    it("should return null for non-existent document", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      let duplicatedId
      act(() => {
        duplicatedId = result.current.duplicateDocument("non-existent")
      })

      expect(duplicatedId).toBeNull()
      expect(mockCreateCanvasDocument).not.toHaveBeenCalled()
    })
  })

  describe("getDocumentsBySession", () => {
    it("should return documents for specific session", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const sessionDocs = result.current.getDocumentsBySession("session-1")

      expect(sessionDocs).toHaveLength(2)
      expect(sessionDocs.map((doc) => doc.id)).toEqual(["doc-1", "doc-2"])
    })

    it("should return empty array for non-existent session", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const sessionDocs = result.current.getDocumentsBySession("non-existent")

      expect(sessionDocs).toEqual([])
    })
  })

  describe("searchDocuments", () => {
    it("should search documents by title", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const searchResults = result.current.searchDocuments("Document 1")

      expect(searchResults).toHaveLength(1)
      expect(searchResults[0].id).toBe("doc-1")
    })

    it("should search documents by content", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const searchResults = result.current.searchDocuments("Content 2")

      expect(searchResults).toHaveLength(1)
      expect(searchResults[0].id).toBe("doc-2")
    })

    it("should search documents by language", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const searchResults = result.current.searchDocuments("python")

      expect(searchResults).toHaveLength(1)
      expect(searchResults[0].id).toBe("doc-2")
    })

    it("should be case insensitive", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const searchResults = result.current.searchDocuments("DOCUMENT")

      expect(searchResults).toHaveLength(3) // All contain "Document" in title
    })

    it("should return empty results for no matches", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const searchResults = result.current.searchDocuments("non-existent")

      expect(searchResults).toEqual([])
    })

    it("should handle empty search query", () => {
      const { result } = renderHook(() => useCanvasDocuments())

      const searchResults = result.current.searchDocuments("")

      expect(searchResults).toHaveLength(3) // All documents match empty query
    })
  })

  describe("edge cases", () => {
    it("should handle documents with same updatedAt timestamp", () => {
      const docsWithSameTime = {
        "doc-1": { ...mockCanvasDocuments["doc-1"], updatedAt: new Date("2024-01-15T10:00:00") },
        "doc-2": { ...mockCanvasDocuments["doc-2"], updatedAt: new Date("2024-01-15T10:00:00") },
      }

      ;(jest.requireMock("@/stores").useArtifactStore as jest.Mock).mockImplementation(
        (selector) => {
          const state = {
            canvasDocuments: docsWithSameTime,
            activeCanvasId: null,
            createCanvasDocument: mockCreateCanvasDocument,
            updateCanvasDocument: mockUpdateCanvasDocument,
            deleteCanvasDocument: mockDeleteCanvasDocument,
            setActiveCanvas: mockSetActiveCanvas,
            openPanel: mockOpenPanel,
          }
          return selector(state)
        }
      )

      const { result } = renderHook(() => useCanvasDocuments())

      expect(result.current.documents).toHaveLength(2)
    })

    it("should handle undefined activeCanvasId in store", () => {
      ;(jest.requireMock("@/stores").useArtifactStore as jest.Mock).mockImplementation(
        (selector) => {
          const state = {
            canvasDocuments: mockCanvasDocuments,
            activeCanvasId: undefined,
            createCanvasDocument: mockCreateCanvasDocument,
            updateCanvasDocument: mockUpdateCanvasDocument,
            deleteCanvasDocument: mockDeleteCanvasDocument,
            setActiveCanvas: mockSetActiveCanvas,
            openPanel: mockOpenPanel,
          }
          return selector(state)
        }
      )

      const { result } = renderHook(() => useCanvasDocuments())

      expect(result.current.activeDocument).toBeNull()
      expect(result.current.activeDocumentId).toBeUndefined()
    })
  })
})
