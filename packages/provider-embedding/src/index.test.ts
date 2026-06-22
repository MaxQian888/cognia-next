import { chunkDocument, cosineSimilarity, getEmbeddingDimension, normalizeEmbedding } from "./index"

describe("provider-embedding package barrel", () => {
  it("re-exports embedding math helpers", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1)
    expect(normalizeEmbedding([3, 4])).toEqual([0.6, 0.8])
  })

  it("re-exports chunking and model metadata helpers", () => {
    const result = chunkDocument("alpha beta gamma delta", { strategy: "fixed", chunkSize: 2 })
    expect(result.chunks.length).toBeGreaterThan(0)
    expect(getEmbeddingDimension("text-embedding-3-small")).toBe(1536)
  })
})
