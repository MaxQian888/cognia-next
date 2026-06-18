/**
 * Tests for sparse embedding utilities
 */

import {
  generateSparseEmbedding,
  generateSparseEmbeddings,
  sparseCosineSimilarity,
} from "./sparse-embedding"

describe("sparse-embedding", () => {
  it("generates sparse embeddings with configured dimension", () => {
    const embedding = generateSparseEmbedding("hello world", {
      hashingBuckets: 64,
      maxFeatures: 8,
    })

    expect(embedding.dimension).toBe(64)
    expect(embedding.indices.length).toBeGreaterThan(0)
    expect(embedding.values.length).toBe(embedding.indices.length)
  })

  it("limits max features", () => {
    const embedding = generateSparseEmbedding("one two three four five six", {
      maxFeatures: 2,
    })

    expect(embedding.indices.length).toBeLessThanOrEqual(2)
  })

  it("generates sparse embeddings in batch", async () => {
    const embeddings = await generateSparseEmbeddings(["alpha beta", "gamma delta"])

    expect(embeddings).toHaveLength(2)
    expect(embeddings[0].indices.length).toBeGreaterThan(0)
  })

  it("computes cosine similarity for matching text", () => {
    const a = generateSparseEmbedding("machine learning")
    const b = generateSparseEmbedding("machine learning")
    const score = sparseCosineSimilarity(a, b)

    expect(score).toBeCloseTo(1, 5)
  })

  it("returns low similarity for different text", () => {
    const a = generateSparseEmbedding("machine learning")
    const b = generateSparseEmbedding("ocean waves")
    const score = sparseCosineSimilarity(a, b)

    expect(score).toBeLessThan(0.5)
  })
})
