/**
 * Tests for multimodal embedding utilities
 */

import {
  generateTextEmbedding,
  generateImageEmbedding,
  generateMultimodalEmbedding,
} from "./multimodal-embedding"

function magnitude(vector: number[]): number {
  return Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0))
}

describe("multimodal-embedding", () => {
  it("generates normalized text embeddings", () => {
    const embedding = generateTextEmbedding("hello", { dimension: 16 })

    expect(embedding).toHaveLength(16)
    expect(magnitude(embedding)).toBeCloseTo(1, 5)
  })

  it("generates normalized image embeddings", () => {
    const embedding = generateImageEmbedding("image-seed", { dimension: 16 })

    expect(embedding).toHaveLength(16)
    expect(magnitude(embedding)).toBeCloseTo(1, 5)
  })

  it("blends text and image embeddings", () => {
    const embedding = generateMultimodalEmbedding(
      { text: "hello", image: "image-seed" },
      { dimension: 16 }
    )

    expect(embedding).toHaveLength(16)
    expect(magnitude(embedding)).toBeCloseTo(1, 5)
  })

  it("returns zero vector when no input provided", () => {
    const embedding = generateMultimodalEmbedding({}, { dimension: 8 })

    expect(embedding).toHaveLength(8)
    expect(magnitude(embedding)).toBe(0)
  })
})
