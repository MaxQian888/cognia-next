/**
 * Tests for Large File Optimizer
 */

import { LargeFileOptimizer, largeFileOptimizer } from "./large-file-optimizer"

describe("LargeFileOptimizer", () => {
  let optimizer: LargeFileOptimizer

  beforeEach(() => {
    optimizer = new LargeFileOptimizer(100) // Small chunk size for testing
  })

  describe("isLargeFile", () => {
    it("should detect large files", () => {
      const largeContent = "x".repeat(60000)
      expect(optimizer.isLargeFile(largeContent)).toBe(true)
    })

    it("should detect small files", () => {
      const smallContent = "small content"
      expect(optimizer.isLargeFile(smallContent)).toBe(false)
    })
  })

  describe("chunkContent", () => {
    it("should chunk a document into pieces", () => {
      const content = "line1\nline2\nline3\nline4\nline5"
      const result = optimizer.chunkContent("test-doc", content)

      expect(result.id).toBe("test-doc")
      expect(result.lineCount).toBe(5)
      expect(result.chunks.length).toBeGreaterThan(0)
    })

    it("should handle empty content", () => {
      const result = optimizer.chunkContent("empty-doc", "")

      expect(result.id).toBe("empty-doc")
      expect(result.lineCount).toBe(1)
    })

    it("should preserve content integrity", () => {
      const content = "Hello\nWorld\nTest\nData"
      const result = optimizer.chunkContent("integrity-doc", content)

      const reconstructed = result.chunks.join("")
      expect(reconstructed).toBe(content)
    })

    it("should track line offsets", () => {
      const content = "line1\nline2\nline3"
      const result = optimizer.chunkContent("offset-doc", content)

      expect(result.lineOffsets.length).toBeGreaterThan(0)
      expect(result.lineOffsets[0]).toBe(0)
    })
  })

  describe("assembleContent", () => {
    it("should reassemble content from chunks", () => {
      const original = "Hello\nWorld\nTest"
      const chunked = optimizer.chunkContent("assemble-doc", original)
      const reassembled = optimizer.assembleContent(chunked)

      expect(reassembled).toBe(original)
    })
  })

  describe("getChunkRange", () => {
    it("should get content for a line range", () => {
      const content = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")
      const doc = optimizer.chunkContent("range-doc", content)

      const rangeContent = optimizer.getChunkRange(doc, 2, 5)
      expect(rangeContent).toBeTruthy()
      expect(rangeContent.length).toBeGreaterThan(0)
    })
  })

  describe("buildIncrementalIndex", () => {
    it("should create document index", () => {
      const content = "function test() {\n  return 42;\n}"
      const index = optimizer.buildIncrementalIndex(content)

      expect(index.lineToChunk).toBeDefined()
      expect(index.chunkToLines).toBeDefined()
    })
  })

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(largeFileOptimizer).toBeInstanceOf(LargeFileOptimizer)
    })
  })
})
