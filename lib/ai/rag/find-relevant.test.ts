/**
 * Tests for find-relevant.ts
 *
 * Tests the findRelevantContent API and related utilities
 */

import {
  findRelevantContent,
  findRelevantContentWithEmbedding,
  batchFindRelevantContent,
  findMostRelevant,
  hasRelevantContent,
  groupBySimilarity,
  type DocumentWithEmbedding,
  type RelevantContent,
} from "./find-relevant"

// Mock the AI SDK embed functions
jest.mock("ai", () => ({
  embed: jest.fn(),
  embedMany: jest.fn(),
}))

// Mock cosineSimilarity
jest.mock("@/lib/ai/embedding/embedding", () => ({
  cosineSimilarity: jest.fn((a: number[], b: number[]) => {
    // Simple mock: return 1 if arrays are equal, else calculate dot product
    if (a.length !== b.length) return 0
    let dot = 0,
      normA = 0,
      normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const mag = Math.sqrt(normA) * Math.sqrt(normB)
    return mag === 0 ? 0 : dot / mag
  }),
}))

import { embed, embedMany } from "ai"

const mockEmbed = embed as jest.MockedFunction<typeof embed>
const mockEmbedMany = embedMany as jest.MockedFunction<typeof embedMany>

// Test data
const createMockDocuments = (): DocumentWithEmbedding[] => [
  {
    id: "doc1",
    content: "Machine learning is a subset of artificial intelligence.",
    embedding: [1, 0, 0, 0],
    metadata: { source: "wiki", title: "ML Basics" },
  },
  {
    id: "doc2",
    content: "Deep learning uses neural networks with many layers.",
    embedding: [0.9, 0.1, 0, 0],
    metadata: { source: "textbook" },
  },
  {
    id: "doc3",
    content: "Python is a popular programming language.",
    embedding: [0, 0, 1, 0],
    metadata: { source: "docs" },
  },
  {
    id: "doc4",
    content: "JavaScript runs in web browsers.",
    embedding: [0, 0, 0.8, 0.2],
    metadata: { source: "docs" },
  },
  {
    id: "doc5",
    content: "Neural networks are inspired by biological neurons.",
    embedding: [0.8, 0.2, 0, 0],
    metadata: { source: "wiki" },
  },
]

// Test-only fixture; real embedding-model interface is internal to `ai` and
// not exported. `unknown` keeps the assertion site type-checked while
// allowing the test to pass this stub through APIs that expect the full
// `EmbeddingModelV1` shape.
const mockEmbeddingModel: unknown = {
  specificationVersion: "v1",
  provider: "test",
  modelId: "test-embed",
  maxEmbeddingsPerCall: 100,
  supportsParallelCalls: true,
}

describe("find-relevant", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("findRelevantContentWithEmbedding", () => {
    it("should find relevant documents based on embedding similarity", () => {
      const documents = createMockDocuments()
      const queryEmbedding = [1, 0, 0, 0] // Similar to doc1

      const results = findRelevantContentWithEmbedding(queryEmbedding, documents, {
        similarityThreshold: 0.5,
        topK: 3,
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe("doc1")
      expect(results[0].similarity).toBeCloseTo(1, 5)
    })

    it("should filter by similarity threshold", () => {
      const documents = createMockDocuments()
      const queryEmbedding = [1, 0, 0, 0]

      const results = findRelevantContentWithEmbedding(queryEmbedding, documents, {
        similarityThreshold: 0.99, // Very high threshold
        topK: 10,
      })

      // Results filtered by high threshold - doc1 should be first (exact match)
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].id).toBe("doc1")
    })

    it("should limit results by topK", () => {
      const documents = createMockDocuments()
      const queryEmbedding = [0.5, 0.5, 0.5, 0.5]

      const results = findRelevantContentWithEmbedding(queryEmbedding, documents, {
        similarityThreshold: 0,
        topK: 2,
      })

      expect(results.length).toBe(2)
    })

    it("should return empty array for empty documents", () => {
      const results = findRelevantContentWithEmbedding([1, 0, 0], [], {})
      expect(results).toEqual([])
    })

    it("should sort by similarity descending", () => {
      const documents = createMockDocuments()
      const queryEmbedding = [0.9, 0.1, 0, 0]

      const results = findRelevantContentWithEmbedding(queryEmbedding, documents, {
        similarityThreshold: 0,
        topK: 5,
      })

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity)
      }
    })

    it("should include metadata in results", () => {
      const documents = createMockDocuments()
      const queryEmbedding = [1, 0, 0, 0]

      const results = findRelevantContentWithEmbedding(queryEmbedding, documents, {
        similarityThreshold: 0.9,
        topK: 1,
      })

      expect(results[0].metadata).toEqual({ source: "wiki", title: "ML Basics" })
    })

    it("should use default options when not provided", () => {
      const documents = createMockDocuments()
      const queryEmbedding = [1, 0, 0, 0]

      const results = findRelevantContentWithEmbedding(queryEmbedding, documents)

      expect(results.length).toBeLessThanOrEqual(5) // Default topK
    })
  })

  describe("findRelevantContent", () => {
    it("should generate embedding and find relevant content", async () => {
      const documents = createMockDocuments()
      mockEmbed.mockResolvedValueOnce({
        embedding: [1, 0, 0, 0],
        value: "query",
        usage: { tokens: 10 },
        warnings: [],
      })

      const results = await findRelevantContent("What is machine learning?", documents, {
        embeddingModel: mockEmbeddingModel,
        similarityThreshold: 0.5,
        topK: 3,
      })

      expect(mockEmbed).toHaveBeenCalledWith({
        model: mockEmbeddingModel,
        value: "What is machine learning?",
        maxRetries: 2,
        abortSignal: undefined,
      })
      expect(results.length).toBeGreaterThan(0)
    })

    it("should return empty array for empty documents", async () => {
      const results = await findRelevantContent("query", [], {
        embeddingModel: mockEmbeddingModel,
      })

      expect(results).toEqual([])
      expect(mockEmbed).not.toHaveBeenCalled()
    })

    it("should pass maxRetries option", async () => {
      const documents = createMockDocuments()
      mockEmbed.mockResolvedValueOnce({
        embedding: [1, 0, 0, 0],
        value: "query",
        usage: { tokens: 10 },
        warnings: [],
      })

      await findRelevantContent("query", documents, {
        embeddingModel: mockEmbeddingModel,
        maxRetries: 5,
      })

      expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 5 }))
    })

    it("should pass abortSignal option", async () => {
      const documents = createMockDocuments()
      const controller = new AbortController()
      mockEmbed.mockResolvedValueOnce({
        embedding: [1, 0, 0, 0],
        value: "query",
        usage: { tokens: 10 },
        warnings: [],
      })

      await findRelevantContent("query", documents, {
        embeddingModel: mockEmbeddingModel,
        abortSignal: controller.signal,
      })

      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: controller.signal })
      )
    })
  })

  describe("batchFindRelevantContent", () => {
    it("should find relevant content for multiple queries", async () => {
      const documents = createMockDocuments()
      mockEmbedMany.mockResolvedValueOnce({
        embeddings: [
          [1, 0, 0, 0], // ML query
          [0, 0, 1, 0], // Python query
        ],
        values: ["machine learning", "python programming"],
        usage: { tokens: 20 },
        warnings: [],
      })

      const results = await batchFindRelevantContent(
        ["machine learning", "python programming"],
        documents,
        {
          embeddingModel: mockEmbeddingModel,
          similarityThreshold: 0.5,
          topK: 2,
        }
      )

      expect(results.size).toBe(2)
      expect(results.get("machine learning")).toBeDefined()
      expect(results.get("python programming")).toBeDefined()
    })

    it("should return empty map for empty queries", async () => {
      const documents = createMockDocuments()

      const results = await batchFindRelevantContent([], documents, {
        embeddingModel: mockEmbeddingModel,
      })

      expect(results.size).toBe(0)
      expect(mockEmbedMany).not.toHaveBeenCalled()
    })

    it("should return empty map for empty documents", async () => {
      const results = await batchFindRelevantContent(["query1", "query2"], [], {
        embeddingModel: mockEmbeddingModel,
      })

      expect(results.size).toBe(0)
    })
  })

  describe("findMostRelevant", () => {
    it("should return the most relevant document", async () => {
      const documents = createMockDocuments()
      mockEmbed.mockResolvedValueOnce({
        embedding: [1, 0, 0, 0],
        value: "query",
        usage: { tokens: 10 },
        warnings: [],
      })

      const result = await findMostRelevant("machine learning", documents, {
        embeddingModel: mockEmbeddingModel,
        similarityThreshold: 0.5,
      })

      expect(result).not.toBeNull()
      expect(result?.id).toBe("doc1")
    })

    it("should return null when no document meets threshold", async () => {
      const documents = createMockDocuments()
      mockEmbed.mockResolvedValueOnce({
        embedding: [0, 0, 0, 1], // Unrelated
        value: "query",
        usage: { tokens: 10 },
        warnings: [],
      })

      const result = await findMostRelevant("query", documents, {
        embeddingModel: mockEmbeddingModel,
        similarityThreshold: 0.9,
      })

      expect(result).toBeNull()
    })
  })

  describe("hasRelevantContent", () => {
    it("should return true when relevant content exists", async () => {
      const documents = createMockDocuments()
      mockEmbed.mockResolvedValueOnce({
        embedding: [1, 0, 0, 0],
        value: "query",
        usage: { tokens: 10 },
        warnings: [],
      })

      const result = await hasRelevantContent("machine learning", documents, {
        embeddingModel: mockEmbeddingModel,
        similarityThreshold: 0.5,
      })

      expect(result).toBe(true)
    })

    it("should return false when no relevant content exists", async () => {
      const documents = createMockDocuments()
      mockEmbed.mockResolvedValueOnce({
        embedding: [0, 0, 0, 1],
        value: "query",
        usage: { tokens: 10 },
        warnings: [],
      })

      const result = await hasRelevantContent("unrelated topic", documents, {
        embeddingModel: mockEmbeddingModel,
        similarityThreshold: 0.9,
      })

      expect(result).toBe(false)
    })
  })

  describe("groupBySimilarity", () => {
    it("should group results by similarity ranges", () => {
      const results: RelevantContent[] = [
        { id: "1", content: "a", similarity: 0.95, metadata: {} },
        { id: "2", content: "b", similarity: 0.85, metadata: {} },
        { id: "3", content: "c", similarity: 0.75, metadata: {} },
        { id: "4", content: "d", similarity: 0.65, metadata: {} },
        { id: "5", content: "e", similarity: 0.55, metadata: {} },
        { id: "6", content: "f", similarity: 0.45, metadata: {} },
      ]

      const groups = groupBySimilarity(results)

      expect(groups.high.length).toBe(2) // 0.95, 0.85
      expect(groups.medium.length).toBe(2) // 0.75, 0.65
      expect(groups.low.length).toBe(2) // 0.55, 0.45
    })

    it("should use custom ranges", () => {
      const results: RelevantContent[] = [
        { id: "1", content: "a", similarity: 0.9, metadata: {} },
        { id: "2", content: "b", similarity: 0.5, metadata: {} },
      ]

      const groups = groupBySimilarity(results, [
        { label: "excellent", min: 0.8, max: 1.0 },
        { label: "good", min: 0.4, max: 0.8 },
      ])

      expect(groups.excellent.length).toBe(1)
      expect(groups.good.length).toBe(1)
    })

    it("should handle empty results", () => {
      const groups = groupBySimilarity([])

      expect(groups.high).toEqual([])
      expect(groups.medium).toEqual([])
      expect(groups.low).toEqual([])
    })
  })
})
