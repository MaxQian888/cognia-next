/**
 * Tests for Reranker Module
 */

import {
  rerankWithHeuristics,
  rerankWithMMR,
  filterByRelevance,
  boostByMetadata,
  boostByRecency,
  type RerankDocument,
  type RerankResult,
} from "./reranker"

describe("rerankWithHeuristics", () => {
  const documents: RerankDocument[] = [
    { id: "doc1", content: "Machine learning is a subset of artificial intelligence", score: 0.8 },
    { id: "doc2", content: "Deep learning neural networks process data", score: 0.7 },
    { id: "doc3", content: "Python programming language for beginners", score: 0.6 },
  ]

  it("reranks documents based on query relevance", () => {
    const results = rerankWithHeuristics("machine learning", documents, { topN: 3 })

    expect(results.length).toBe(3)
    expect(results[0].id).toBe("doc1") // Contains "machine learning"
  })

  it("respects topN limit", () => {
    const results = rerankWithHeuristics("learning", documents, { topN: 2 })

    expect(results.length).toBe(2)
  })

  it("handles exact query match with bonus", () => {
    const docsWithExact: RerankDocument[] = [
      { id: "doc1", content: "What is machine learning?", score: 0.5 },
      { id: "doc2", content: "Machine learning overview", score: 0.5 },
    ]

    const results = rerankWithHeuristics("machine learning", docsWithExact, { topN: 2 })

    // Both contain the query, but scores should reflect term matching
    expect(results.every((r) => r.rerankScore > 0)).toBe(true)
  })

  it("handles empty documents array", () => {
    const results = rerankWithHeuristics("test query", [], { topN: 5 })

    expect(results.length).toBe(0)
  })

  it("handles query with no matching terms", () => {
    const results = rerankWithHeuristics("xyz123 nonexistent", documents, { topN: 3 })

    // Should still return results, just with lower scores
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it("applies custom weights", () => {
    const resultsDefault = rerankWithHeuristics("machine", documents, { topN: 3 })
    const resultsCustom = rerankWithHeuristics("machine", documents, {
      topN: 3,
      weights: {
        exactMatch: 0.8,
        termOverlap: 0.1,
        positionBoost: 0.05,
        lengthPenalty: 0.05,
      },
    })

    // Results should be different with different weights
    expect(resultsDefault[0].rerankScore).not.toBe(resultsCustom[0].rerankScore)
  })

  it("preserves original score in results", () => {
    const results = rerankWithHeuristics("machine", documents, { topN: 3 })

    const doc1Result = results.find((r) => r.id === "doc1")
    expect(doc1Result?.originalScore).toBe(0.8)
  })
})

describe("rerankWithMMR", () => {
  const documents: RerankDocument[] = [
    { id: "doc1", content: "Machine learning basics", score: 0.9 },
    { id: "doc2", content: "Machine learning advanced", score: 0.85 },
    { id: "doc3", content: "Deep learning fundamentals", score: 0.8 },
  ]

  // Create simple embeddings for testing
  const queryEmbedding = [1, 0, 0]
  const documentEmbeddings = new Map<string, number[]>([
    ["doc1", [0.9, 0.1, 0]], // Similar to query
    ["doc2", [0.85, 0.15, 0]], // Also similar to query
    ["doc3", [0.5, 0.5, 0]], // Different direction
  ])

  it("selects diverse documents with MMR", () => {
    const results = rerankWithMMR(documents, queryEmbedding, documentEmbeddings, {
      topN: 3,
      lambda: 0.5, // Balance relevance and diversity
    })

    expect(results.length).toBe(3)
  })

  it("with high lambda, prioritizes relevance", () => {
    const resultsHighLambda = rerankWithMMR(documents, queryEmbedding, documentEmbeddings, {
      topN: 2,
      lambda: 1.0, // Max relevance
    })

    // Should pick the most relevant documents
    expect(resultsHighLambda[0].id).toBe("doc1")
  })

  it("with low lambda, prioritizes diversity", () => {
    const resultsLowLambda = rerankWithMMR(documents, queryEmbedding, documentEmbeddings, {
      topN: 2,
      lambda: 0.0, // Max diversity
    })

    // After picking first doc, should pick most diverse (doc3)
    expect(resultsLowLambda.map((r) => r.id)).toContain("doc3")
  })

  it("handles empty documents array", () => {
    const results = rerankWithMMR([], queryEmbedding, new Map(), { topN: 5 })

    expect(results.length).toBe(0)
  })

  it("handles missing embeddings gracefully", () => {
    const incompleteEmbeddings = new Map<string, number[]>([
      ["doc1", [0.9, 0.1, 0]],
      // doc2 and doc3 missing
    ])

    const results = rerankWithMMR(documents, queryEmbedding, incompleteEmbeddings, {
      topN: 3,
    })

    // Should only include document with embedding
    expect(results.length).toBeLessThanOrEqual(1)
  })
})

describe("filterByRelevance", () => {
  const results: RerankResult[] = [
    { id: "doc1", content: "High score", rerankScore: 0.9, originalScore: 0.8 },
    { id: "doc2", content: "Medium score", rerankScore: 0.6, originalScore: 0.5 },
    { id: "doc3", content: "Low score", rerankScore: 0.3, originalScore: 0.2 },
  ]

  it("filters results below threshold", () => {
    const filtered = filterByRelevance(results, 0.5)

    expect(filtered.length).toBe(2)
    expect(filtered.every((r) => r.rerankScore >= 0.5)).toBe(true)
  })

  it("returns all results when threshold is 0", () => {
    const filtered = filterByRelevance(results, 0)

    expect(filtered.length).toBe(3)
  })

  it("returns empty when threshold is too high", () => {
    const filtered = filterByRelevance(results, 1.0)

    expect(filtered.length).toBe(0)
  })

  it("handles empty results array", () => {
    const filtered = filterByRelevance([], 0.5)

    expect(filtered.length).toBe(0)
  })
})

describe("boostByMetadata", () => {
  const results: RerankResult[] = [
    {
      id: "doc1",
      content: "Content A",
      rerankScore: 0.5,
      metadata: { category: "tech", priority: "high" },
    },
    {
      id: "doc2",
      content: "Content B",
      rerankScore: 0.5,
      metadata: { category: "science", priority: "low" },
    },
    {
      id: "doc3",
      content: "Content C",
      rerankScore: 0.5,
      metadata: { category: "tech", priority: "low" },
    },
  ]

  it("boosts results matching metadata criteria", () => {
    const boosted = boostByMetadata(results, [{ field: "category", value: "tech", boost: 2.0 }])

    const doc1 = boosted.find((r) => r.id === "doc1")
    const doc2 = boosted.find((r) => r.id === "doc2")

    expect(doc1?.rerankScore).toBe(1.0) // 0.5 * 2.0
    expect(doc2?.rerankScore).toBe(0.5) // Unchanged
  })

  it("applies multiple boost criteria", () => {
    const boosted = boostByMetadata(results, [
      { field: "category", value: "tech", boost: 2.0 },
      { field: "priority", value: "high", boost: 1.5 },
    ])

    const doc1 = boosted.find((r) => r.id === "doc1")

    expect(doc1?.rerankScore).toBe(1.5) // 0.5 * 2.0 * 1.5
  })

  it("sorts results by boosted score", () => {
    const boosted = boostByMetadata(results, [{ field: "category", value: "tech", boost: 2.0 }])

    expect(boosted[0].id).toBe("doc1")
    expect(boosted[1].id).toBe("doc3")
  })

  it("handles missing metadata gracefully", () => {
    const resultsNoMeta: RerankResult[] = [{ id: "doc1", content: "Content", rerankScore: 0.5 }]

    const boosted = boostByMetadata(resultsNoMeta, [
      { field: "category", value: "tech", boost: 2.0 },
    ])

    expect(boosted[0].rerankScore).toBe(0.5) // Unchanged
  })
})

describe("boostByRecency", () => {
  const now = Date.now()
  const oneHourAgo = now - 60 * 60 * 1000
  const oneDayAgo = now - 24 * 60 * 60 * 1000
  const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000

  const results: RerankResult[] = [
    { id: "doc1", content: "Recent", rerankScore: 0.5, metadata: { createdAt: oneHourAgo } },
    { id: "doc2", content: "Old", rerankScore: 0.5, metadata: { createdAt: oneDayAgo } },
    { id: "doc3", content: "Very old", rerankScore: 0.5, metadata: { createdAt: oneMonthAgo } },
  ]

  it("boosts more recent documents", () => {
    const boosted = boostByRecency(results, {
      dateField: "createdAt",
      maxAgeHours: 24 * 7, // 1 week
      boostFactor: 1.5,
    })

    const doc1 = boosted.find((r) => r.id === "doc1")
    const doc2 = boosted.find((r) => r.id === "doc2")

    expect(doc1?.rerankScore).toBeGreaterThan(doc2?.rerankScore || 0)
  })

  it("sorts by boosted score", () => {
    const boosted = boostByRecency(results, {
      dateField: "createdAt",
      maxAgeHours: 24 * 7,
      boostFactor: 2.0,
    })

    expect(boosted[0].id).toBe("doc1") // Most recent should be first
  })

  it("does not boost documents outside max age", () => {
    const boosted = boostByRecency(results, {
      dateField: "createdAt",
      maxAgeHours: 1, // Only last hour
      boostFactor: 2.0,
    })

    const doc3 = boosted.find((r) => r.id === "doc3")
    expect(doc3?.rerankScore).toBe(0.5) // Unchanged
  })

  it("handles missing date field", () => {
    const resultsNoDate: RerankResult[] = [
      { id: "doc1", content: "Content", rerankScore: 0.5, metadata: {} },
    ]

    const boosted = boostByRecency(resultsNoDate, {
      dateField: "createdAt",
      boostFactor: 2.0,
    })

    expect(boosted[0].rerankScore).toBe(0.5)
  })

  it("handles date strings", () => {
    const resultsWithStrings: RerankResult[] = [
      {
        id: "doc1",
        content: "Content",
        rerankScore: 0.5,
        metadata: { createdAt: new Date(oneHourAgo).toISOString() },
      },
    ]

    const boosted = boostByRecency(resultsWithStrings, {
      dateField: "createdAt",
      maxAgeHours: 24,
      boostFactor: 1.5,
    })

    expect(boosted[0].rerankScore).toBeGreaterThan(0.5)
  })
})
