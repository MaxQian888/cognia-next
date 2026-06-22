/**
 * Tests for Document Chunking utilities
 */

import {
  chunkDocument,
  chunkDocumentAsync,
  chunkDocumentSemantic,
  chunkDocumentSmart,
  chunkDocumentRecursive,
  chunkDocumentSlidingWindow,
  chunkCodeDocument,
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

    it("routes recursive and code strategies through the main chunker", () => {
      const recursive = chunkDocument("Alpha\n\nBeta\n\nGamma", {
        strategy: "recursive",
        chunkSize: 8,
        chunkOverlap: 2,
        minChunkSize: 1,
      })
      const code = chunkDocument("function first() {}\n\nfunction second() {}", {
        strategy: "code",
        chunkSize: 30,
        chunkOverlap: 0,
      })

      expect(recursive.strategy).toBe("recursive")
      expect(recursive.totalChunks).toBeGreaterThan(1)
      expect(recursive.chunks.every((chunk) => /^chunk-\d+-\d+$/.test(chunk.id))).toBe(true)
      expect(code.strategy).toBe("code")
      expect(code.chunks.map((chunk) => chunk.content)).toEqual([
        "function first() {}",
        "function second() {}",
      ])
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

    it("falls back when the semantic model throws or produces an empty result", async () => {
      const model = {} as LanguageModel

      ;(generateText as jest.Mock).mockRejectedValueOnce(new Error("model offline"))
      await expect(
        chunkDocumentAsync("# Title\n\nFallback body", {
          strategy: "semantic",
          model,
          chunkSize: 10,
        })
      ).resolves.toMatchObject({ strategy: "heading", totalChunks: 1 })

      await expect(
        chunkDocumentAsync("", {
          strategy: "semantic",
          model,
          chunkSize: 10,
        })
      ).resolves.toMatchObject({ strategy: "heading", totalChunks: 0 })
    })
  })
})

describe("advanced chunking strategies", () => {
  it("retains sentence overlap when overlap can include prior sentences", () => {
    const result = chunkDocument(
      "First sentence is here. Second sentence is here. Third sentence is here.",
      {
        strategy: "sentence",
        chunkSize: 35,
        chunkOverlap: 30,
      }
    )

    expect(result.chunks).toHaveLength(3)
    expect(result.chunks[1].content).toContain("First sentence is here.")
    expect(result.chunks[1].content).toContain("Second sentence is here.")
  })

  it("keeps pre-heading content and splits large heading sections", () => {
    const result = chunkDocument("Preface text\n\n# First\n\n" + "A".repeat(40) + "\n\n# Second", {
      strategy: "heading",
      chunkSize: 20,
      chunkOverlap: 100,
    })

    expect(result.chunks[0].content).toBe("Preface text")
    expect(result.chunks.some((chunk) => chunk.content.includes("# First"))).toBe(true)
    expect(result.totalChunks).toBeGreaterThan(1)
  })

  it("selects smart strategies from markdown, paragraph, sentence, and fixed-shaped input", () => {
    const heading = chunkDocumentSmart("# Title\n\nShort body.", { chunkSize: 20 }, "heading-doc")
    const paragraph = chunkDocumentSmart(
      "Long paragraph with enough words to push the average sentence length high\n\nSecond long paragraph with enough detail to select paragraph chunking",
      { chunkSize: 80 },
      "paragraph-doc"
    )
    const sentence = chunkDocumentSmart(
      "This sentence has enough length for the sentence chunking heuristic. Another long sentence follows.",
      { chunkSize: 70 },
      "sentence-doc"
    )
    const fixed = chunkDocumentSmart("Tiny. Text.", { chunkSize: 20 }, "fixed-doc")

    expect(heading.chunks[0].id).toBe("heading-doc-chunk-0")
    expect(paragraph.strategy).toBe("paragraph")
    expect(sentence.strategy).toBe("sentence")
    expect(fixed.strategy).toBe("fixed")
  })

  it("handles recursive empty input, separator recursion, and forced splitting", () => {
    expect(chunkDocumentRecursive("").chunks).toEqual([])

    const separated = chunkDocumentRecursive("alpha beta gamma delta", {
      maxChunkSize: 9,
      minChunkSize: 1,
      overlap: 2,
      separators: [" "],
    })
    const forced = chunkDocumentRecursive("abcdefghijklmnopqrstuvwxyz", {
      maxChunkSize: 8,
      minChunkSize: 1,
      overlap: 2,
      separators: ["|"],
    })

    expect(separated.chunks.length).toBeGreaterThan(1)
    expect(forced.chunks.map((chunk) => chunk.content)).toEqual([
      "abcdefgh",
      "ghijklmn",
      "mnopqrst",
      "stuvwxyz",
    ])
  })

  it("supports sliding windows with empty input, next-space preservation, and raw windows", () => {
    expect(chunkDocumentSlidingWindow("").chunks).toEqual([])

    const nextSpace = chunkDocumentSlidingWindow("abcdefghij klmnopqrst uvwxyz", {
      windowSize: 5,
      stepSize: 10,
      preserveWords: true,
    })
    const raw = chunkDocumentSlidingWindow("abcdefghij", {
      windowSize: 4,
      stepSize: 4,
      preserveWords: false,
    })

    expect(nextSpace.chunks[0].content).toBe("abcdefghij")
    expect(raw.chunks.map((chunk) => chunk.content)).toEqual(["abcd", "efgh", "ij"])
  })

  it("uses semantic split points with de-duplication and fallback handling", async () => {
    const model = {} as LanguageModel
    const text = "A".repeat(40) + "B".repeat(40) + "C".repeat(40)

    ;(generateText as jest.Mock).mockResolvedValueOnce({ text: "split at [40, 40, -1, 500, 80]" })
    const semantic = await chunkDocumentSemantic(text, model, {
      targetChunkSize: 30,
      documentId: "semantic-doc",
    })

    expect(semantic.chunks).toHaveLength(3)
    expect(semantic.chunks[0]).toMatchObject({
      id: "semantic-doc-chunk-0",
      content: "A".repeat(40),
      metadata: { semantic: true },
    })
    ;(generateText as jest.Mock).mockResolvedValueOnce({ text: "[not-json]" })
    await expect(
      chunkDocumentSemantic("# Fallback\n\nBody", model, { targetChunkSize: 5 })
    ).resolves.toMatchObject({ strategy: "heading" })

    await expect(chunkDocumentSemantic("Short text", model)).resolves.toMatchObject({
      totalChunks: 1,
      strategy: "semantic",
    })
    await expect(chunkDocumentSemantic("", model)).resolves.toMatchObject({
      totalChunks: 0,
      strategy: "semantic",
    })
  })

  it("chunks code by language patterns, recursive fallback, headers, and large blocks", () => {
    expect(chunkCodeDocument("").chunks).toEqual([])

    const fallback = chunkCodeDocument("plain text without declarations ".repeat(40), {
      maxChunkSize: 120,
    })
    const python = chunkCodeDocument("def one():\n  pass\n\nclass Two:\n  pass", {
      language: "python",
      maxChunkSize: 100,
      preserveContext: false,
    })
    const typed = chunkCodeDocument(
      `${"// header ".repeat(8)}\nexport interface Config { value: string }\n\nexport function run() {\n${"  console.log('x')\n".repeat(20)}}`,
      {
        language: "typescript",
        maxChunkSize: 80,
      },
      "code-doc"
    )

    expect(fallback.totalChunks).toBeGreaterThan(0)
    expect(python.chunks.map((chunk) => chunk.content.split("\n")[0])).toEqual([
      "def one():",
      "class Two:",
    ])
    expect(typed.chunks[0].content).toContain("// header")
    expect(typed.chunks.every((chunk) => chunk.id.startsWith("code-doc-chunk-"))).toBe(true)
    expect(typed.chunks.every((chunk) => chunk.metadata?.language === "typescript")).toBe(true)
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
