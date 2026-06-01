import { cosineSimilarity, dedupeByEmbedding, findMostSimilar } from "./vector"

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1)
  })

  it("returns 0 for empty or mismatched-length vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([1, 2], [1])).toBe(0)
  })

  it("returns 0 when either vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe("dedupeByEmbedding", () => {
  it("drops near-duplicate items keeping the first", () => {
    const items = ["a", "b", "c"]
    const embeddings = [
      [1, 0],
      [0.999, 0.001], // near-duplicate of a
      [0, 1],
    ]
    expect(dedupeByEmbedding(items, embeddings, 0.95)).toEqual(["a", "c"])
  })

  it("keeps everything when nothing is similar enough", () => {
    const items = ["a", "b"]
    const embeddings = [
      [1, 0],
      [0, 1],
    ]
    expect(dedupeByEmbedding(items, embeddings, 0.9)).toEqual(["a", "b"])
  })

  it("treats a missing embedding as a zero vector (never a duplicate)", () => {
    const items = ["a", "b"]
    const embeddings = [[1, 0]] // b has no embedding
    expect(dedupeByEmbedding(items, embeddings, 0.9)).toEqual(["a", "b"])
  })
})

describe("findMostSimilar", () => {
  const candidates = [
    { id: "x", embedding: [1, 0] },
    { id: "y", embedding: [0, 1] },
    { id: "z", embedding: [0.7, 0.7] },
  ]

  it("ranks by similarity descending and truncates to topK", () => {
    const out = findMostSimilar([1, 0], candidates, { topK: 2 })
    expect(out.map((r) => r.id)).toEqual(["x", "z"])
  })

  it("applies the threshold filter", () => {
    const out = findMostSimilar([1, 0], candidates, { threshold: 0.99 })
    expect(out.map((r) => r.id)).toEqual(["x"])
  })

  it("returns an empty array when nothing clears the threshold", () => {
    expect(findMostSimilar([0, -1], candidates, { threshold: 0.5 })).toEqual([])
  })
})
