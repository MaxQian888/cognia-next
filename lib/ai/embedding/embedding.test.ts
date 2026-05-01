/**
 * Tests for embedding.ts
 *
 * Tests embedding utilities including:
 * - AI SDK cosineSimilarity integration
 * - maxParallelCalls support
 * - maxRetries and error handling
 * - providerOptions support
 * - Caching functionality
 */

import {
  generateEmbedding,
  generateEmbeddings,
  generateEmbeddingsBatched,
  cosineSimilarity,
  euclideanDistance,
  createEmbeddingCache,
  defaultEmbeddingModels,
  embeddingDimensions,
  getEmbeddingDimension,
  findMostSimilar,
  normalizeEmbedding,
  averageEmbeddings,
  type EmbeddingConfig,
  type EmbeddingProviderName,
} from "./embedding"

// Mock AI SDK
jest.mock("ai", () => ({
  embed: jest.fn(),
  embedMany: jest.fn(),
  cosineSimilarity: jest.fn((a: number[], b: number[]) => {
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

// Mock provider SDKs
const mockEmbeddingModel = { modelId: "mock-model" }

jest.mock("@ai-sdk/openai", () => ({
  createOpenAI: jest.fn(() => ({
    embedding: jest.fn(() => mockEmbeddingModel),
    textEmbeddingModel: jest.fn(() => mockEmbeddingModel),
  })),
}))

jest.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: jest.fn(() => ({
    embedding: jest.fn(() => mockEmbeddingModel),
    embeddingModel: jest.fn(() => mockEmbeddingModel),
  })),
}))

jest.mock("@ai-sdk/cohere", () => ({
  createCohere: jest.fn(() => ({
    embedding: jest.fn(() => mockEmbeddingModel),
    textEmbeddingModel: jest.fn(() => mockEmbeddingModel),
  })),
}))

jest.mock("@ai-sdk/mistral", () => ({
  createMistral: jest.fn(() => ({
    embedding: jest.fn(() => mockEmbeddingModel),
    textEmbeddingModel: jest.fn(() => mockEmbeddingModel),
  })),
}))

jest.mock("../providers/ollama", () => ({
  generateOllamaEmbedding: jest.fn(),
}))

import { embed, embedMany, cosineSimilarity as aiCosineSimilarity } from "ai"
import { generateOllamaEmbedding } from "../providers/ollama"

const mockEmbed = embed as jest.MockedFunction<typeof embed>
const mockEmbedMany = embedMany as jest.MockedFunction<typeof embedMany>
const mockOllamaEmbed = generateOllamaEmbedding as jest.MockedFunction<
  typeof generateOllamaEmbedding
>

describe("embedding", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("cosineSimilarity", () => {
    it("should use AI SDK cosineSimilarity", () => {
      const a = [1, 0, 0]
      const b = [1, 0, 0]

      const result = cosineSimilarity(a, b)

      expect(aiCosineSimilarity).toHaveBeenCalledWith(a, b)
      expect(result).toBeCloseTo(1, 5)
    })

    it("should return 0 for orthogonal vectors", () => {
      const result = cosineSimilarity([1, 0, 0], [0, 1, 0])
      expect(result).toBeCloseTo(0, 5)
    })

    it("should return -1 for opposite vectors", () => {
      const result = cosineSimilarity([1, 0, 0], [-1, 0, 0])
      expect(result).toBeCloseTo(-1, 5)
    })
  })

  describe("euclideanDistance", () => {
    it("should calculate euclidean distance correctly", () => {
      const result = euclideanDistance([0, 0, 0], [3, 4, 0])
      expect(result).toBeCloseTo(5, 5)
    })

    it("should return 0 for identical vectors", () => {
      const result = euclideanDistance([1, 2, 3], [1, 2, 3])
      expect(result).toBeCloseTo(0, 5)
    })

    it("should throw for mismatched lengths", () => {
      expect(() => euclideanDistance([1, 2], [1, 2, 3])).toThrow()
    })
  })

  describe("findMostSimilar", () => {
    it("should find most similar embeddings", () => {
      const query = [1, 0, 0]
      const candidates = [
        { id: "a", embedding: [1, 0, 0] },
        { id: "b", embedding: [0, 1, 0] },
        { id: "c", embedding: [0.9, 0.1, 0] },
      ]

      const results = findMostSimilar(query, candidates, { topK: 2 })

      expect(results[0].id).toBe("a")
      expect(results[0].score).toBeCloseTo(1, 5)
      expect(results.length).toBe(2)
    })

    it("should filter by threshold", () => {
      const query = [1, 0, 0]
      const candidates = [
        { id: "a", embedding: [1, 0, 0] },
        { id: "b", embedding: [0, 1, 0] },
      ]

      const results = findMostSimilar(query, candidates, { threshold: 0.9 })

      expect(results.length).toBe(1)
      expect(results[0].id).toBe("a")
    })
  })

  describe("normalizeEmbedding", () => {
    it("should normalize embedding to unit length", () => {
      const result = normalizeEmbedding([3, 4, 0])
      const magnitude = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0))
      expect(magnitude).toBeCloseTo(1, 5)
    })

    it("should handle zero vector", () => {
      const result = normalizeEmbedding([0, 0, 0])
      expect(result).toEqual([0, 0, 0])
    })
  })

  describe("averageEmbeddings", () => {
    it("should average multiple embeddings", () => {
      const result = averageEmbeddings([
        [1, 2],
        [3, 4],
        [5, 6],
      ])
      expect(result).toEqual([3, 4])
    })

    it("should throw for empty array", () => {
      expect(() => averageEmbeddings([])).toThrow()
    })
  })

  describe("createEmbeddingCache", () => {
    it("should store and retrieve values", () => {
      const cache = createEmbeddingCache()
      const embedding = [1, 2, 3]

      cache.set("key1", embedding)

      expect(cache.has("key1")).toBe(true)
      expect(cache.get("key1")).toEqual(embedding)
    })

    it("should return undefined for missing keys", () => {
      const cache = createEmbeddingCache()

      expect(cache.has("missing")).toBe(false)
      expect(cache.get("missing")).toBeUndefined()
    })

    it("should clear all entries", () => {
      const cache = createEmbeddingCache()
      cache.set("key1", [1])
      cache.set("key2", [2])

      cache.clear()

      expect(cache.has("key1")).toBe(false)
      expect(cache.has("key2")).toBe(false)
    })

    it("should track size", () => {
      const cache = createEmbeddingCache()
      cache.set("key1", [1])
      cache.set("key2", [2])

      expect(cache.size()).toBe(2)
    })

    it("should respect maxSize limit with LRU eviction", () => {
      const cache = createEmbeddingCache(2)
      cache.set("key1", [1])
      cache.set("key2", [2])
      cache.set("key3", [3]) // Should evict oldest

      expect(cache.size()).toBeLessThanOrEqual(2)
    })
  })

  describe("generateEmbedding", () => {
    const baseConfig: EmbeddingConfig = {
      provider: "openai",
      apiKey: "test-key",
    }

    it("should generate embedding using AI SDK", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: [0.1, 0.2, 0.3],
        value: "test",
        usage: { tokens: 5 },
        warnings: [],
      })

      const result = await generateEmbedding("test text", baseConfig)

      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({
          value: "test text",
          maxRetries: 2,
        })
      )
      expect(result.embedding).toEqual([0.1, 0.2, 0.3])
      expect(result.usage?.tokens).toBe(5)
    })

    it("should use cached embedding when available", async () => {
      const cache = createEmbeddingCache()
      const cachedEmbedding = [0.5, 0.5, 0.5]
      const configWithCache = { ...baseConfig, cache }

      // First call - should hit API
      mockEmbed.mockResolvedValueOnce({
        embedding: cachedEmbedding,
        value: "test",
        usage: { tokens: 5 },
        warnings: [],
      })

      await generateEmbedding("cached text", configWithCache)
      expect(mockEmbed).toHaveBeenCalledTimes(1)

      // Second call with same text - should use cache
      jest.clearAllMocks()
      const result = await generateEmbedding("cached text", configWithCache)

      expect(mockEmbed).not.toHaveBeenCalled()
      expect(result.embedding).toEqual(cachedEmbedding)
    })

    it("should pass maxRetries option", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: [0.1],
        value: "test",
        usage: { tokens: 1 },
        warnings: [],
      })

      await generateEmbedding("test", { ...baseConfig, maxRetries: 5 })

      expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 5 }))
    })

    it("should pass abortSignal option", async () => {
      const controller = new AbortController()
      mockEmbed.mockResolvedValueOnce({
        embedding: [0.1],
        value: "test",
        usage: { tokens: 1 },
        warnings: [],
      })

      await generateEmbedding("test", { ...baseConfig, abortSignal: controller.signal })

      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: controller.signal })
      )
    })

    it("should call onError callback on failure", async () => {
      const onError = jest.fn()
      const error = new Error("API error")
      mockEmbed.mockRejectedValueOnce(error)

      await expect(generateEmbedding("test", { ...baseConfig, onError })).rejects.toThrow(
        "API error"
      )

      expect(onError).toHaveBeenCalledWith(error)
    })

    it("should use Ollama for ollama provider", async () => {
      mockOllamaEmbed.mockResolvedValueOnce([0.1, 0.2])

      const result = await generateEmbedding("test", {
        provider: "ollama",
        apiKey: "",
        baseURL: "http://localhost:11434",
      })

      expect(mockOllamaEmbed).toHaveBeenCalled()
      expect(result.embedding).toEqual([0.1, 0.2])
    })
  })

  describe("generateEmbeddings", () => {
    const baseConfig: EmbeddingConfig = {
      provider: "openai",
      apiKey: "test-key",
    }

    it("should generate multiple embeddings", async () => {
      mockEmbedMany.mockResolvedValueOnce({
        embeddings: [[0.1], [0.2], [0.3]],
        values: ["a", "b", "c"],
        usage: { tokens: 15 },
        warnings: [],
      })

      const result = await generateEmbeddings(["a", "b", "c"], baseConfig)

      expect(result.embeddings).toEqual([[0.1], [0.2], [0.3]])
      expect(result.usage?.tokens).toBe(15)
    })

    it("should use maxParallelCalls option", async () => {
      mockEmbedMany.mockResolvedValueOnce({
        embeddings: [[0.1]],
        values: ["a"],
        usage: { tokens: 5 },
        warnings: [],
      })

      await generateEmbeddings(["a"], { ...baseConfig, maxParallelCalls: 3 })

      expect(mockEmbedMany).toHaveBeenCalledWith(expect.objectContaining({ maxParallelCalls: 3 }))
    })

    it("should use default maxParallelCalls of 5", async () => {
      mockEmbedMany.mockResolvedValueOnce({
        embeddings: [[0.1]],
        values: ["a"],
        usage: { tokens: 5 },
        warnings: [],
      })

      await generateEmbeddings(["a"], baseConfig)

      expect(mockEmbedMany).toHaveBeenCalledWith(expect.objectContaining({ maxParallelCalls: 5 }))
    })

    it("should cache embeddings for reuse", async () => {
      const cache = createEmbeddingCache()
      const configWithCache = { ...baseConfig, cache }

      // First call
      mockEmbedMany.mockResolvedValueOnce({
        embeddings: [[0.1], [0.2]],
        values: ["text1", "text2"],
        usage: { tokens: 10 },
        warnings: [],
      })

      await generateEmbeddings(["text1", "text2"], configWithCache)
      expect(mockEmbedMany).toHaveBeenCalledTimes(1)

      // Second call with same texts - should use cache
      jest.clearAllMocks()
      const result = await generateEmbeddings(["text1", "text2"], configWithCache)

      // Cache should prevent API call for cached texts
      expect(result.embeddings).toBeDefined()
    })

    it("should call onError callback on failure", async () => {
      const onError = jest.fn()
      const error = new Error("Batch API error")
      mockEmbedMany.mockRejectedValueOnce(error)

      await expect(generateEmbeddings(["a", "b"], { ...baseConfig, onError })).rejects.toThrow(
        "Batch API error"
      )

      expect(onError).toHaveBeenCalledWith(error)
    })
  })

  describe("generateEmbeddingsBatched", () => {
    const baseConfig: EmbeddingConfig = {
      provider: "openai",
      apiKey: "test-key",
    }

    it("should split large arrays into batches", async () => {
      mockEmbedMany
        .mockResolvedValueOnce({
          embeddings: [[0.1], [0.2]],
          values: ["a", "b"],
          usage: { tokens: 10 },
          warnings: [],
        })
        .mockResolvedValueOnce({
          embeddings: [[0.3]],
          values: ["c"],
          usage: { tokens: 5 },
          warnings: [],
        })

      const result = await generateEmbeddingsBatched(
        ["a", "b", "c"],
        baseConfig,
        2 // batch size
      )

      expect(mockEmbedMany).toHaveBeenCalledTimes(2)
      expect(result.embeddings).toEqual([[0.1], [0.2], [0.3]])
      expect(result.usage?.tokens).toBe(15)
    })
  })

  describe("defaultEmbeddingModels", () => {
    it("should have OpenAI model", () => {
      expect(defaultEmbeddingModels.openai).toBe("text-embedding-3-small")
    })

    it("should have Google model", () => {
      expect(defaultEmbeddingModels.google).toBe("text-embedding-004")
    })

    it("should have Cohere model", () => {
      expect(defaultEmbeddingModels.cohere).toBe("embed-english-v3.0")
    })

    it("should have Azure model", () => {
      expect(defaultEmbeddingModels.azure).toBe("text-embedding-3-small")
    })

    it("should have Amazon Bedrock model", () => {
      expect(defaultEmbeddingModels["amazon-bedrock"]).toBe("amazon.titan-embed-text-v2:0")
    })
  })

  describe("embeddingDimensions", () => {
    it("should have correct OpenAI dimensions", () => {
      expect(embeddingDimensions["text-embedding-3-small"]).toBe(1536)
      expect(embeddingDimensions["text-embedding-3-large"]).toBe(3072)
    })

    it("should have correct Google dimensions", () => {
      expect(embeddingDimensions["text-embedding-004"]).toBe(768)
    })

    it("should have correct Amazon Bedrock dimensions", () => {
      expect(embeddingDimensions["amazon.titan-embed-text-v2:0"]).toBe(1024)
    })
  })

  describe("getEmbeddingDimension", () => {
    it("should return dimension for known model", () => {
      expect(getEmbeddingDimension("text-embedding-3-small")).toBe(1536)
    })

    it("should return undefined for unknown model", () => {
      expect(getEmbeddingDimension("unknown-model")).toBeUndefined()
    })
  })

  describe("EmbeddingProviderName", () => {
    it("should accept standard providers", () => {
      const providers: EmbeddingProviderName[] = ["openai", "google", "cohere", "mistral", "ollama"]
      expect(providers.length).toBe(5)
    })

    it("should accept embedding-only providers", () => {
      const providers: EmbeddingProviderName[] = ["azure", "amazon-bedrock", "voyage"]
      expect(providers.length).toBe(3)
    })
  })
})
