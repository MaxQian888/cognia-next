/**
 * Embedding Utilities Tests
 */

import {
  createInMemoryEmbeddingCache,
  normalizeEmbedding,
  euclideanDistance,
  dotProduct,
  averageEmbeddings,
  calculateSimilarityMatrix,
  clusterBySimilarity,
  reduceEmbeddingDimensions,
  EMBEDDING_MODELS,
} from "./embedding-utils"

// Mock the AI SDK
jest.mock("ai", () => ({
  embed: jest.fn(),
  embedMany: jest.fn(),
  cosineSimilarity: jest.fn((a: number[], b: number[]) => {
    const dotProd = a.reduce((sum, val, i) => sum + val * b[i], 0)
    const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
    const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
    return dotProd / (magA * magB)
  }),
}))

import { cosineSimilarity } from "ai"

describe("Embedding Utilities", () => {
  describe("createInMemoryEmbeddingCache", () => {
    it("should store and retrieve embeddings", async () => {
      const cache = createInMemoryEmbeddingCache()
      const embedding = [0.1, 0.2, 0.3]

      await cache.set("test text", embedding)
      const result = await cache.get("test text")

      expect(result).toEqual(embedding)
    })

    it("should return null for missing keys", async () => {
      const cache = createInMemoryEmbeddingCache()

      const result = await cache.get("nonexistent")

      expect(result).toBeNull()
    })

    it("should check if key exists", async () => {
      const cache = createInMemoryEmbeddingCache()

      await cache.set("exists", [1, 2, 3])

      expect(await cache.has("exists")).toBe(true)
      expect(await cache.has("missing")).toBe(false)
    })

    it("should evict oldest entries when at capacity", async () => {
      const cache = createInMemoryEmbeddingCache(2)

      await cache.set("first", [1])
      await cache.set("second", [2])
      await cache.set("third", [3]) // Should evict 'first'

      expect(await cache.get("first")).toBeNull()
      expect(await cache.get("second")).toEqual([2])
      expect(await cache.get("third")).toEqual([3])
    })
  })

  describe("normalizeEmbedding", () => {
    it("should normalize to unit length", () => {
      const embedding = [3, 4] // magnitude = 5
      const normalized = normalizeEmbedding(embedding)

      expect(normalized[0]).toBeCloseTo(0.6)
      expect(normalized[1]).toBeCloseTo(0.8)

      // Check magnitude is 1
      const magnitude = Math.sqrt(normalized.reduce((sum, val) => sum + val * val, 0))
      expect(magnitude).toBeCloseTo(1)
    })

    it("should handle zero vector", () => {
      const embedding = [0, 0, 0]
      const normalized = normalizeEmbedding(embedding)

      expect(normalized).toEqual([0, 0, 0])
    })
  })

  describe("euclideanDistance", () => {
    it("should calculate correct distance", () => {
      const a = [0, 0]
      const b = [3, 4]

      const distance = euclideanDistance(a, b)

      expect(distance).toBe(5)
    })

    it("should return 0 for identical vectors", () => {
      const a = [1, 2, 3]

      const distance = euclideanDistance(a, a)

      expect(distance).toBe(0)
    })

    it("should throw for different dimensions", () => {
      const a = [1, 2]
      const b = [1, 2, 3]

      expect(() => euclideanDistance(a, b)).toThrow("same dimensions")
    })
  })

  describe("dotProduct", () => {
    it("should calculate correct dot product", () => {
      const a = [1, 2, 3]
      const b = [4, 5, 6]

      const result = dotProduct(a, b)

      expect(result).toBe(32) // 1*4 + 2*5 + 3*6
    })

    it("should return 0 for orthogonal vectors", () => {
      const a = [1, 0]
      const b = [0, 1]

      const result = dotProduct(a, b)

      expect(result).toBe(0)
    })

    it("should throw for different dimensions", () => {
      const a = [1, 2]
      const b = [1, 2, 3]

      expect(() => dotProduct(a, b)).toThrow("same dimensions")
    })
  })

  describe("averageEmbeddings", () => {
    it("should calculate average of embeddings", () => {
      const embeddings = [
        [1, 2, 3],
        [3, 4, 5],
        [5, 6, 7],
      ]

      const avg = averageEmbeddings(embeddings)

      expect(avg).toEqual([3, 4, 5])
    })

    it("should handle single embedding", () => {
      const embeddings = [[1, 2, 3]]

      const avg = averageEmbeddings(embeddings)

      expect(avg).toEqual([1, 2, 3])
    })

    it("should return empty array for empty input", () => {
      const avg = averageEmbeddings([])

      expect(avg).toEqual([])
    })
  })

  describe("calculateSimilarityMatrix", () => {
    it("should create symmetric similarity matrix", () => {
      const embeddings = [
        [1, 0],
        [0, 1],
        [1, 1],
      ]

      const matrix = calculateSimilarityMatrix(embeddings)

      // Should be symmetric
      expect(matrix[0][1]).toEqual(matrix[1][0])
      expect(matrix[0][2]).toEqual(matrix[2][0])
      expect(matrix[1][2]).toEqual(matrix[2][1])

      // Diagonal should be 1 (self-similarity)
      expect(matrix[0][0]).toBeCloseTo(1)
      expect(matrix[1][1]).toBeCloseTo(1)
      expect(matrix[2][2]).toBeCloseTo(1)
    })

    it("should handle empty input", () => {
      const matrix = calculateSimilarityMatrix([])

      expect(matrix).toEqual([])
    })
  })

  describe("clusterBySimilarity", () => {
    beforeEach(() => {
      // Mock cosineSimilarity to return predictable values
      ;(cosineSimilarity as jest.Mock).mockImplementation((a: number[], b: number[]) => {
        const dotProd = a.reduce((sum, val, i) => sum + val * b[i], 0)
        const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
        const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
        return dotProd / (magA * magB)
      })
    })

    it("should cluster similar items together", () => {
      const embeddings = [
        [1, 0], // cluster 1
        [0.99, 0.1], // cluster 1 (similar to first)
        [0, 1], // cluster 2
        [0.1, 0.99], // cluster 2 (similar to third)
      ]
      const texts = ["a", "b", "c", "d"]

      const clusters = clusterBySimilarity(embeddings, texts, 0.9)

      expect(clusters.length).toBeGreaterThanOrEqual(2)
    })

    it("should handle single item", () => {
      const clusters = clusterBySimilarity([[1, 0]], ["single"], 0.9)

      expect(clusters).toEqual([["single"]])
    })
  })

  describe("reduceEmbeddingDimensions", () => {
    it("should truncate to target dimensions", () => {
      const embeddings = [
        [1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10],
      ]

      const reduced = reduceEmbeddingDimensions(embeddings, 3)

      expect(reduced[0]).toEqual([1, 2, 3])
      expect(reduced[1]).toEqual([6, 7, 8])
    })

    it("should return original if target >= current dimensions", () => {
      const embeddings = [[1, 2, 3]]

      const reduced = reduceEmbeddingDimensions(embeddings, 5)

      expect(reduced).toBe(embeddings)
    })

    it("should handle empty input", () => {
      const reduced = reduceEmbeddingDimensions([], 3)

      expect(reduced).toEqual([])
    })
  })

  describe("EMBEDDING_MODELS", () => {
    it("should have OpenAI models", () => {
      expect(EMBEDDING_MODELS.openai["text-embedding-3-large"].dimensions).toBe(3072)
      expect(EMBEDDING_MODELS.openai["text-embedding-3-small"].dimensions).toBe(1536)
    })

    it("should have Google models", () => {
      expect(EMBEDDING_MODELS.google["gemini-embedding-001"].dimensions).toBe(3072)
    })

    it("should have Mistral models", () => {
      expect(EMBEDDING_MODELS.mistral["mistral-embed"].dimensions).toBe(1024)
    })
  })
})
