/**
 * Tests for useChunkLoader hook
 */

import { renderHook, act } from "@testing-library/react"
import { useChunkLoader } from "./use-chunk-loader"

// Mock stores
const mockLoadChunkRange = jest.fn()
const mockUpdateVisibleRange = jest.fn()
const mockIsLargeDocument = jest.fn()
const mockGetDocumentContent = jest.fn()

jest.mock("@/stores/canvas", () => ({
  useChunkedDocumentStore: jest.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      chunkedDocuments: {},
      loadChunkRange: mockLoadChunkRange,
      updateVisibleRange: mockUpdateVisibleRange,
      isLargeDocument: mockIsLargeDocument,
      getDocumentContent: mockGetDocumentContent,
    }
    return typeof selector === "function" ? selector(state) : state
  }),
}))

// Mock large file optimizer
jest.mock("@/lib/canvas/large-file-optimizer", () => ({
  LargeFileOptimizer: jest.fn().mockImplementation(() => ({})),
}))

describe("useChunkLoader", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLoadChunkRange.mockReturnValue("loaded content")
    mockIsLargeDocument.mockReturnValue(false)
    mockGetDocumentContent.mockReturnValue("full content")
  })

  describe("initialization", () => {
    it("subscribes to a selected chunk store slice", () => {
      renderHook(() => useChunkLoader(null))

      expect(jest.requireMock("@/stores/canvas").useChunkedDocumentStore).toHaveBeenCalledWith(
        expect.any(Function)
      )
    })

    it("should initialize with default state when documentId is null", () => {
      const { result } = renderHook(() => useChunkLoader(null))

      expect(result.current.state.content).toBe("")
      expect(result.current.state.startLine).toBe(0)
      expect(result.current.state.endLine).toBe(0)
      expect(result.current.state.isLoading).toBe(false)
      expect(result.current.state.totalLines).toBe(0)
      expect(result.current.isLargeDocument).toBe(false)
    })

    it("should check isLargeDocument for valid documentId", () => {
      mockIsLargeDocument.mockReturnValue(true)

      const { result } = renderHook(() => useChunkLoader("doc-123"))

      expect(mockIsLargeDocument).toHaveBeenCalledWith("doc-123")
      expect(result.current.isLargeDocument).toBe(true)
    })

    it("should return false for isLargeDocument when documentId is null", () => {
      const { result } = renderHook(() => useChunkLoader(null))

      expect(result.current.isLargeDocument).toBe(false)
    })
  })

  describe("loadRange", () => {
    it("should not load when documentId is null", () => {
      const { result } = renderHook(() => useChunkLoader(null))

      act(() => {
        result.current.loadRange(0, 100)
      })

      expect(mockLoadChunkRange).not.toHaveBeenCalled()
    })

    it("should load content with buffered range", () => {
      const mockChunkedDocs = {
        "doc-123": { lineCount: 1000 },
      }

      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: mockChunkedDocs,
        loadChunkRange: mockLoadChunkRange,
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      const { result } = renderHook(() => useChunkLoader("doc-123"))

      act(() => {
        result.current.loadRange(100, 200)
      })

      // BUFFER_LINES = 100, so bufferedStart = 0, bufferedEnd = 300
      expect(mockLoadChunkRange).toHaveBeenCalledWith("doc-123", 0, 300)
      expect(mockUpdateVisibleRange).toHaveBeenCalledWith("doc-123", 100, 200)
    })

    it("should update state after loading", () => {
      const mockChunkedDocs = {
        "doc-123": { lineCount: 500 },
      }

      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: mockChunkedDocs,
        loadChunkRange: mockLoadChunkRange.mockReturnValue("chunk content"),
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      const { result } = renderHook(() => useChunkLoader("doc-123"))

      act(() => {
        result.current.loadRange(50, 150)
      })

      expect(result.current.state.content).toBe("chunk content")
      expect(result.current.state.isLoading).toBe(false)
      expect(result.current.state.totalLines).toBe(500)
    })

    it("should not update state when loadChunkRange returns null", () => {
      const mockChunkedDocs = {
        "doc-123": { lineCount: 500 },
      }

      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: mockChunkedDocs,
        loadChunkRange: mockLoadChunkRange.mockReturnValue(null),
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      const { result } = renderHook(() => useChunkLoader("doc-123"))
      const initialContent = result.current.state.content

      act(() => {
        result.current.loadRange(50, 150)
      })

      expect(result.current.state.content).toBe(initialContent)
    })
  })

  describe("loadMore", () => {
    it("should not load when documentId is null", () => {
      const { result } = renderHook(() => useChunkLoader(null))

      act(() => {
        result.current.loadMore("down")
      })

      expect(mockLoadChunkRange).not.toHaveBeenCalled()
    })

    it("should load more content upward", () => {
      const mockChunkedDocs = {
        "doc-123": { lineCount: 1000 },
      }

      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: mockChunkedDocs,
        loadChunkRange: mockLoadChunkRange.mockReturnValue("content"),
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      const { result } = renderHook(() => useChunkLoader("doc-123"))

      // First set some initial state by loading a range
      act(() => {
        result.current.loadRange(200, 400)
      })

      // Clear mock to check next call
      mockLoadChunkRange.mockClear()
      mockUpdateVisibleRange.mockClear()

      act(() => {
        result.current.loadMore("up", 50)
      })

      // Should load more lines upward
      expect(mockLoadChunkRange).toHaveBeenCalled()
    })

    it("should load more content downward", () => {
      const mockChunkedDocs = {
        "doc-123": { lineCount: 1000 },
      }

      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: mockChunkedDocs,
        loadChunkRange: mockLoadChunkRange.mockReturnValue("content"),
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      const { result } = renderHook(() => useChunkLoader("doc-123"))

      // First set some initial state by loading a range
      act(() => {
        result.current.loadRange(100, 300)
      })

      mockLoadChunkRange.mockClear()

      act(() => {
        result.current.loadMore("down", 50)
      })

      expect(mockLoadChunkRange).toHaveBeenCalled()
    })

    it("should use default LOAD_THRESHOLD when lines not specified", () => {
      const mockChunkedDocs = {
        "doc-123": { lineCount: 1000 },
      }

      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: mockChunkedDocs,
        loadChunkRange: mockLoadChunkRange.mockReturnValue("content"),
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      const { result } = renderHook(() => useChunkLoader("doc-123"))

      act(() => {
        result.current.loadRange(200, 400)
      })

      mockLoadChunkRange.mockClear()

      act(() => {
        result.current.loadMore("down") // Default lines = LOAD_THRESHOLD = 50
      })

      expect(mockLoadChunkRange).toHaveBeenCalled()
    })
  })

  describe("getFullContent", () => {
    it("should return null when documentId is null", () => {
      const { result } = renderHook(() => useChunkLoader(null))

      const content = result.current.getFullContent()

      expect(content).toBeNull()
    })

    it("should return full content from store", () => {
      mockGetDocumentContent.mockReturnValue("full document content")

      const { result } = renderHook(() => useChunkLoader("doc-123"))

      const content = result.current.getFullContent()

      expect(mockGetDocumentContent).toHaveBeenCalledWith("doc-123")
      expect(content).toBe("full document content")
    })
  })

  describe("auto-load on mount", () => {
    it("should auto-load when documentId and chunkedDoc exist", async () => {
      const mockChunkedDocs = {
        "doc-123": { lineCount: 500 },
      }

      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: mockChunkedDocs,
        loadChunkRange: mockLoadChunkRange.mockReturnValue("content"),
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      renderHook(() => useChunkLoader("doc-123"))

      // Wait for microtask (queueMicrotask in the hook)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(mockLoadChunkRange).toHaveBeenCalled()
    })

    it("should not auto-load when chunkedDoc does not exist", async () => {
      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: {},
        loadChunkRange: mockLoadChunkRange,
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      renderHook(() => useChunkLoader("non-existent"))

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(mockLoadChunkRange).not.toHaveBeenCalled()
    })
  })

  describe("edge cases", () => {
    it("should handle startLine at 0 with buffer", () => {
      const mockChunkedDocs = {
        "doc-123": { lineCount: 1000 },
      }

      jest.requireMock("@/stores/canvas").useChunkedDocumentStore.mockReturnValue({
        chunkedDocuments: mockChunkedDocs,
        loadChunkRange: mockLoadChunkRange.mockReturnValue("content"),
        updateVisibleRange: mockUpdateVisibleRange,
        isLargeDocument: mockIsLargeDocument,
        getDocumentContent: mockGetDocumentContent,
      })

      const { result } = renderHook(() => useChunkLoader("doc-123"))

      act(() => {
        result.current.loadRange(0, 50)
      })

      // bufferedStart should be Math.max(0, 0 - 100) = 0
      expect(mockLoadChunkRange).toHaveBeenCalledWith("doc-123", 0, 150)
    })

    it("should return all functions and state", () => {
      const { result } = renderHook(() => useChunkLoader("doc-123"))

      expect(typeof result.current.loadRange).toBe("function")
      expect(typeof result.current.loadMore).toBe("function")
      expect(typeof result.current.getFullContent).toBe("function")
      expect(typeof result.current.isLargeDocument).toBe("boolean")
      expect(result.current.state).toHaveProperty("content")
      expect(result.current.state).toHaveProperty("startLine")
      expect(result.current.state).toHaveProperty("endLine")
      expect(result.current.state).toHaveProperty("isLoading")
      expect(result.current.state).toHaveProperty("totalLines")
    })
  })
})
