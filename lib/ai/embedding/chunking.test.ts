/**
 * Tests for Document Chunking utilities
 */

import {
  chunkDocument,
  chunkDocumentAsync,
  estimateChunkCount,
  mergeChunks,
  getChunkStats,
  type DocumentChunk,
} from "./chunking"
import type { LanguageModel } from "ai"

import { generateText } from "ai"

jest.mock("ai", () => ({
  generateText: jest.fn(),
}))

const mockedGenerateText = generateText as jest.Mock

beforeEach(() => {
  mockedGenerateText.mockReset()
})

describe("chunkDocument", () => {
  describe("fixed strategy", () => {
    it("chunks text using fixed-size strategy by default", () => {
      const text = "A".repeat(2500)
      const result = chunkDocument(text, { strategy: "fixed", chunkSize: 1000, chunkOverlap: 200 })

      expect(result.strategy).toBe("fixed")
      expect(result.totalChunks).toBeGreaterThan(1)
      expect(result.originalLength).toBe(2500)
      result.chunks.forEach((chunk) => {
        expect(chunk.content.length).toBeLessThanOrEqual(1000)
      })
    })

    it("handles text shorter than chunk size", () => {
      const text = "Short text"
      const result = chunkDocument(text, { strategy: "fixed", chunkSize: 1000 })

      expect(result.totalChunks).toBe(1)
      expect(result.chunks[0].content).toBe("Short text")
    })

    it("breaks at word boundaries when possible", () => {
      const text = "word ".repeat(200)
      const result = chunkDocument(text, { strategy: "fixed", chunkSize: 100, chunkOverlap: 20 })

      result.chunks.forEach((chunk) => {
        expect(chunk.content).not.toMatch(/^\s/)
        expect(chunk.content).not.toMatch(/\s$/)
      })
    })
  })

  describe("sentence strategy", () => {
    it("chunks text by sentences", () => {
      const text =
        "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence."
      const result = chunkDocument(text, { strategy: "sentence", chunkSize: 50, chunkOverlap: 10 })

      expect(result.strategy).toBe("sentence")
      expect(result.totalChunks).toBeGreaterThan(0)
    })

    it("handles text without sentence endings", () => {
      const text = "No sentence endings here"
      const result = chunkDocument(text, { strategy: "sentence", chunkSize: 100 })

      expect(result.totalChunks).toBe(1)
      expect(result.chunks[0].content).toBe(text)
    })

    it("handles multiple sentence-ending punctuation", () => {
      const text = "Question? Exclamation! Statement. Another one!"
      const result = chunkDocument(text, { strategy: "sentence", chunkSize: 20, chunkOverlap: 5 })

      expect(result.totalChunks).toBeGreaterThan(0)
    })
  })

  describe("paragraph strategy", () => {
    it("chunks text by paragraphs", () => {
      const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
      const result = chunkDocument(text, {
        strategy: "paragraph",
        chunkSize: 100,
        chunkOverlap: 20,
      })

      expect(result.strategy).toBe("paragraph")
      expect(result.totalChunks).toBeGreaterThan(0)
    })

    it("handles text without paragraph breaks", () => {
      const text = "Single paragraph without breaks"
      const result = chunkDocument(text, { strategy: "paragraph", chunkSize: 100 })

      expect(result.totalChunks).toBe(1)
      expect(result.chunks[0].content).toBe(text)
    })
  })

  describe("semantic strategy", () => {
    it("falls back to sentence chunking for semantic", () => {
      const text = "First sentence. Second sentence."
      const result = chunkDocument(text, { strategy: "semantic", chunkSize: 100 })

      expect(result.strategy).toBe("semantic")
      expect(result.totalChunks).toBeGreaterThan(0)
    })
  })

  describe("additional strategies", () => {
    it("supports smart strategy", () => {
      const text = "# Title\n\nParagraph text. Another sentence."
      const result = chunkDocument(text, { strategy: "smart", chunkSize: 50 })

      expect(result.strategy).toBe("smart")
      expect(result.totalChunks).toBeGreaterThan(0)
    })

    it("supports sliding_window strategy", () => {
      const text = "Sliding window chunking preserves overlap between windows for context."
      const result = chunkDocument(text, {
        strategy: "sliding_window",
        chunkSize: 20,
        chunkOverlap: 5,
      })

      expect(result.strategy).toBe("sliding_window")
      expect(result.totalChunks).toBeGreaterThan(1)
    })
  })

  describe("chunk filtering", () => {
    it("filters chunks below minimum size", () => {
      const text = "A. B. C. D. E."
      const result = chunkDocument(text, {
        strategy: "sentence",
        chunkSize: 10,
        chunkOverlap: 0,
        minChunkSize: 5,
      })

      result.chunks.forEach((chunk) => {
        expect(chunk.content.length).toBeGreaterThanOrEqual(5)
      })
    })

    it("filters chunks above maximum size", () => {
      const text = "A".repeat(3000)
      const result = chunkDocument(text, {
        strategy: "fixed",
        chunkSize: 1000,
        chunkOverlap: 0,
        maxChunkSize: 1000,
      })

      result.chunks.forEach((chunk) => {
        expect(chunk.content.length).toBeLessThanOrEqual(1000)
      })
    })
  })

  describe("edge cases", () => {
    it("returns empty result for empty text", () => {
      const result = chunkDocument("")

      expect(result.totalChunks).toBe(0)
      expect(result.chunks).toEqual([])
      expect(result.originalLength).toBe(0)
    })

    it("returns empty result for whitespace-only text", () => {
      const result = chunkDocument("   \n\n   ")

      expect(result.totalChunks).toBe(0)
    })

    it("normalizes CRLF to LF", () => {
      const text = "Line1\r\nLine2\r\nLine3"
      const result = chunkDocument(text, { strategy: "fixed", chunkSize: 1000 })

      expect(result.chunks[0].content).not.toContain("\r")
    })

    it("assigns correct document IDs to chunks", () => {
      const text = "Sample text for chunking"
      const result = chunkDocument(text, { chunkSize: 1000 }, "doc-123")

      expect(result.chunks[0].id).toContain("doc-123")
    })

    it("generates unique IDs when no document ID provided", () => {
      const text = "Sample text"
      const result = chunkDocument(text, { chunkSize: 1000 })

      expect(result.chunks[0].id).toMatch(/^chunk-/)
    })
  })

  describe("chunk metadata", () => {
    it("includes correct start and end offsets", () => {
      const text = "First chunk content. Second chunk content."
      const result = chunkDocument(text, { strategy: "sentence", chunkSize: 25, chunkOverlap: 0 })

      result.chunks.forEach((chunk) => {
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0)
        expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset)
        expect(chunk.endOffset).toBeLessThanOrEqual(text.length)
      })
    })

    it("assigns sequential indices to chunks", () => {
      const text = "A".repeat(3000)
      const result = chunkDocument(text, { strategy: "fixed", chunkSize: 1000, chunkOverlap: 0 })

      result.chunks.forEach((chunk, index) => {
        expect(chunk.index).toBe(index)
      })
    })
  })

  describe("chunkDocumentAsync (semantic)", () => {
    it("uses semantic split points when a model is provided", async () => {
      ;(generateText as jest.Mock).mockResolvedValue({ text: "[10]" })
      const model = {} as LanguageModel

      const result = await chunkDocumentAsync("Sentence one ends here. Sentence two starts now.", {
        strategy: "semantic",
        chunkSize: 30,
        model,
      })

      expect(result.strategy).toBe("semantic")
      expect(result.totalChunks).toBeGreaterThan(0)
    })

    it("falls back to heading strategy when semantic parsing fails", async () => {
      ;(generateText as jest.Mock).mockResolvedValue({ text: "no json here" })
      const model = {} as LanguageModel
      const text = "# Title\n\nSection content."

      const result = await chunkDocumentAsync(text, { strategy: "semantic", model, chunkSize: 20 })

      expect(result.strategy).toBe("heading")
      expect(result.totalChunks).toBeGreaterThan(0)
    })
  })
})

describe("estimateChunkCount", () => {
  it("returns 1 for text shorter than chunk size", () => {
    expect(estimateChunkCount(500, 1000, 200)).toBe(1)
  })

  it("calculates correct count for longer text", () => {
    const count = estimateChunkCount(2500, 1000, 200)
    expect(count).toBeGreaterThan(1)
  })

  it("uses default values when not provided", () => {
    const count = estimateChunkCount(5000)
    expect(count).toBeGreaterThan(1)
  })

  it("handles edge case of exact chunk size", () => {
    expect(estimateChunkCount(1000, 1000, 200)).toBe(1)
  })
})

describe("mergeChunks", () => {
  it("returns empty string for empty array", () => {
    expect(mergeChunks([])).toBe("")
  })

  it("returns content for single chunk", () => {
    const chunks: DocumentChunk[] = [
      { id: "1", content: "Only content", index: 0, startOffset: 0, endOffset: 12 },
    ]
    expect(mergeChunks(chunks)).toBe("Only content")
  })

  it("merges multiple chunks removing overlap", () => {
    const chunks: DocumentChunk[] = [
      { id: "1", content: "Hello world", index: 0, startOffset: 0, endOffset: 11 },
      { id: "2", content: "world again", index: 1, startOffset: 6, endOffset: 17 },
    ]
    const result = mergeChunks(chunks)
    expect(result).toBe("Hello world again")
  })

  it("handles chunks without overlap", () => {
    const chunks: DocumentChunk[] = [
      { id: "1", content: "First", index: 0, startOffset: 0, endOffset: 5 },
      { id: "2", content: "Second", index: 1, startOffset: 5, endOffset: 11 },
    ]
    const result = mergeChunks(chunks)
    expect(result).toBe("FirstSecond")
  })

  it("sorts chunks by index before merging", () => {
    const chunks: DocumentChunk[] = [
      { id: "2", content: "Second", index: 1, startOffset: 5, endOffset: 11 },
      { id: "1", content: "First", index: 0, startOffset: 0, endOffset: 5 },
    ]
    const result = mergeChunks(chunks)
    expect(result).toBe("FirstSecond")
  })
})

describe("getChunkStats", () => {
  it("returns zeros for empty array", () => {
    const stats = getChunkStats([])
    expect(stats).toEqual({
      count: 0,
      avgLength: 0,
      minLength: 0,
      maxLength: 0,
      totalLength: 0,
    })
  })

  it("calculates correct stats for single chunk", () => {
    const chunks: DocumentChunk[] = [
      { id: "1", content: "Hello", index: 0, startOffset: 0, endOffset: 5 },
    ]
    const stats = getChunkStats(chunks)
    expect(stats).toEqual({
      count: 1,
      avgLength: 5,
      minLength: 5,
      maxLength: 5,
      totalLength: 5,
    })
  })

  it("calculates correct stats for multiple chunks", () => {
    const chunks: DocumentChunk[] = [
      { id: "1", content: "Hi", index: 0, startOffset: 0, endOffset: 2 },
      { id: "2", content: "Hello", index: 1, startOffset: 2, endOffset: 7 },
      { id: "3", content: "Hello World", index: 2, startOffset: 7, endOffset: 18 },
    ]
    const stats = getChunkStats(chunks)
    expect(stats.count).toBe(3)
    expect(stats.minLength).toBe(2)
    expect(stats.maxLength).toBe(11)
    expect(stats.totalLength).toBe(18)
    expect(stats.avgLength).toBe(6)
  })
})
