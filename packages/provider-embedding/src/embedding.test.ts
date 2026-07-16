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
  VOYAGE_EMBEDDING_BASE_URL,
  type EmbeddingConfig,
  type EmbeddingProviderName,
} from "./embedding"
import { createOpenAI } from "@ai-sdk/openai"

const mockCreateOpenAI = createOpenAI as unknown as jest.MockedFunction<typeof createOpenAI>

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

jest.mock("@cognia/provider-core/providers/ollama", () => ({
  generateOllamaEmbedding: jest.fn(),
  generateOllamaEmbeddings: jest.fn(),
}))

import { embed, embedMany, cosineSimilarity as aiCosineSimilarity } from "ai"
import {
  generateOllamaEmbedding,
  generateOllamaEmbeddings,
} from "@cognia/provider-core/providers/ollama"

const mockEmbed = embed as jest.MockedFunction<typeof embed>
const mockEmbedMany = embedMany as jest.MockedFunction<typeof embedMany>
const mockOllamaEmbed = generateOllamaEmbedding as jest.MockedFunction<
  typeof generateOllamaEmbedding
>
const mockOllamaEmbedBatch = generateOllamaEmbeddings as jest.MockedFunction<
  typeof generateOllamaEmbeddings
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

    it("supports default options and euclidean scoring", () => {
      const results = findMostSimilar(
        [0, 0],
        [
          { id: "near", embedding: [1, 0] },
          { id: "far", embedding: [3, 4] },
        ],
        { metric: "euclidean" }
      )

      expect(results.map((result) => result.id)).toEqual(["near", "far"])
      expect(findMostSimilar([1], [{ id: "only", embedding: [1] }])).toEqual([
        { id: "only", score: 1 },
      ])
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

    it("should throw when embeddings have different dimensions", () => {
      expect(() => averageEmbeddings([[1, 2], [3]])).toThrow(
        "All embeddings must have the same length"
      )
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

    it("uses Ollama defaults and stores single embeddings in cache", async () => {
      const cache = createEmbeddingCache()
      mockOllamaEmbed.mockResolvedValueOnce([0.7, 0.8])

      const result = await generateEmbedding("test", {
        provider: "ollama",
        apiKey: "",
        cache,
      })

      expect(mockOllamaEmbed).toHaveBeenCalledWith(
        "http://localhost:11434",
        defaultEmbeddingModels.ollama,
        "test"
      )
      expect(result.embedding).toEqual([0.7, 0.8])
      expect(cache.size()).toBe(1)
    })

    it("routes voyage through the OpenAI client at the Voyage base URL", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: [0.4, 0.5],
        value: "test",
        usage: { tokens: 2 },
        warnings: [],
      })

      const result = await generateEmbedding("test", {
        provider: "voyage",
        apiKey: "voyage-key",
      })

      expect(mockCreateOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "voyage-key", baseURL: VOYAGE_EMBEDDING_BASE_URL })
      )
      expect(result.embedding).toEqual([0.4, 0.5])
    })

    it("routes local OpenAI-compatible engines through their /v1 base URL", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: [0.6],
        value: "test",
        usage: { tokens: 1 },
        warnings: [],
      })

      await generateEmbedding("test", {
        provider: "lmstudio" as EmbeddingProviderName,
        apiKey: "",
        baseURL: "http://localhost:1234",
      })

      expect(mockCreateOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "http://localhost:1234/v1" })
      )
    })

    it.each([
      ["google", "text-embedding-004"],
      ["cohere", "embed-english-v3.0"],
      ["mistral", "mistral-embed"],
    ] as const)("routes %s through its embedding client", async (provider, expectedModel) => {
      mockEmbed.mockResolvedValueOnce({
        embedding: [0.9],
        value: "test",
        usage: undefined,
        warnings: [],
      } as unknown as Awaited<ReturnType<typeof embed>>)

      const result = await generateEmbedding("test", {
        provider,
        apiKey: "provider-key",
      })

      expect(result).toEqual({ embedding: [0.9], usage: undefined })
      expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({ model: mockEmbeddingModel }))
      expect(expectedModel).toBe(defaultEmbeddingModels[provider])
    })

    it("throws an actionable error for azure / amazon-bedrock (not bundled)", async () => {
      await expect(generateEmbedding("t", { provider: "azure", apiKey: "k" })).rejects.toThrow(
        /@ai-sdk\/azure/
      )
      await expect(
        generateEmbedding("t", { provider: "amazon-bedrock", apiKey: "k" })
      ).rejects.toThrow(/@ai-sdk\/amazon-bedrock/)
    })

    it("throws for unsupported embedding providers", async () => {
      await expect(
        generateEmbedding("t", { provider: "unsupported" as never, apiKey: "k" })
      ).rejects.toThrow("Embedding not supported for provider: unsupported")
    })

    it("normalizes non-Error single embedding failures for onError", async () => {
      const onError = jest.fn()
      mockEmbed.mockRejectedValueOnce("bad")

      await expect(generateEmbedding("test", { ...baseConfig, onError })).rejects.toBe("bad")
      expect(onError).toHaveBeenCalledWith(expect.any(Error))
      expect(onError.mock.calls[0][0].message).toBe("bad")
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

    it("embeds only uncached texts and preserves cached result positions", async () => {
      const cache = createEmbeddingCache()
      const configWithCache = { ...baseConfig, cache }
      cache.set("openai:default:text1:5", [0.1])
      mockEmbedMany.mockResolvedValueOnce({
        embeddings: [[0.2]],
        values: ["text2"],
        usage: undefined,
        warnings: [],
      } as unknown as Awaited<ReturnType<typeof embedMany>>)

      const result = await generateEmbeddings(["text1", "text2"], configWithCache)

      expect(mockEmbedMany).toHaveBeenCalledWith(
        expect.objectContaining({
          values: ["text2"],
        })
      )
      expect(result).toEqual({ embeddings: [[0.1], [0.2]], usage: undefined })
    })

    it("returns immediately when all batch texts are cached", async () => {
      const cache = createEmbeddingCache()
      const configWithCache = { ...baseConfig, cache }
      cache.set("openai:default:text1:5", [0.1])
      cache.set("openai:default:text2:5", [0.2])

      const result = await generateEmbeddings(["text1", "text2"], configWithCache)

      expect(mockEmbedMany).not.toHaveBeenCalled()
      expect(result).toEqual({ embeddings: [[0.1], [0.2]], usage: undefined })
    })

    /**
     * The predecessor asserted `NthCalledWith(1, …, "a")` and `(2, …, "b")` —
     * it pinned the serial loop as the contract. That loop paid a full HTTP
     * round-trip per text because the deprecated `/api/embeddings` accepted
     * only one `prompt`. `/api/embed` takes the array natively, so a batch of
     * N is now ONE request.
     */
    it("sends one batched request for uncached Ollama embeddings and caches each result", async () => {
      const cache = createEmbeddingCache()
      mockOllamaEmbedBatch.mockResolvedValueOnce([[0.1], [0.2]])

      const result = await generateEmbeddings(["a", "b"], {
        provider: "ollama",
        apiKey: "",
        cache,
      })

      expect(mockOllamaEmbedBatch).toHaveBeenCalledTimes(1)
      expect(mockOllamaEmbedBatch).toHaveBeenCalledWith(
        "http://localhost:11434",
        defaultEmbeddingModels.ollama,
        ["a", "b"]
      )
      // The per-text endpoint must not be touched on the batch path at all.
      expect(mockOllamaEmbed).not.toHaveBeenCalled()
      expect(result).toEqual({ embeddings: [[0.1], [0.2]], usage: undefined })
      expect(cache.size()).toBe(2)
    })

    /**
     * Only the uncached texts go to the server, and each returned vector must
     * land on the text it was computed for — a cache hit in the middle shifts
     * the positions, which is exactly where an index-by-position batch write
     * would silently corrupt results.
     */
    it("keeps vectors aligned with their texts when part of the batch is cached", async () => {
      const cache = createEmbeddingCache()
      // Seed "b" so only "a" and "c" are requested.
      mockOllamaEmbedBatch.mockResolvedValueOnce([[0.2]])
      await generateEmbeddings(["b"], { provider: "ollama", apiKey: "", cache })
      mockOllamaEmbedBatch.mockClear()

      mockOllamaEmbedBatch.mockResolvedValueOnce([[0.1], [0.3]])
      const result = await generateEmbeddings(["a", "b", "c"], {
        provider: "ollama",
        apiKey: "",
        cache,
      })

      expect(mockOllamaEmbedBatch).toHaveBeenCalledWith(
        "http://localhost:11434",
        defaultEmbeddingModels.ollama,
        ["a", "c"]
      )
      expect(result.embeddings).toEqual([[0.1], [0.2], [0.3]])
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

    it("normalizes non-Error batch failures for onError", async () => {
      const onError = jest.fn()
      mockEmbedMany.mockRejectedValueOnce("batch bad")

      await expect(generateEmbeddings(["a", "b"], { ...baseConfig, onError })).rejects.toBe(
        "batch bad"
      )
      expect(onError).toHaveBeenCalledWith(expect.any(Error))
      expect(onError.mock.calls[0][0].message).toBe("batch bad")
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

    it("omits usage when batches do not report tokens", async () => {
      mockEmbedMany.mockResolvedValueOnce({
        embeddings: [[0.1]],
        values: ["a"],
        usage: undefined,
        warnings: [],
      } as unknown as Awaited<ReturnType<typeof embedMany>>)

      const result = await generateEmbeddingsBatched(["a"], baseConfig, 10)

      expect(result).toEqual({ embeddings: [[0.1]], usage: undefined })
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
