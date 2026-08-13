/**
 * Tests for Hybrid Search Module
 */

import {
  BM25Index,
  HybridSearchEngine,
  reciprocalRankFusion,
  normalizeScores,
  deduplicateResults,
  createHybridSearchEngine,
} from "./hybrid-search"

describe("BM25Index", () => {
  let index: BM25Index

  beforeEach(() => {
    index = new BM25Index()
  })

  describe("addDocument", () => {
    it("adds a document to the index", () => {
      index.addDocument("doc1", "hello world")
      expect(index.size()).toBe(1)
      expect(index.hasDocument("doc1")).toBe(true)
    })

    it("handles multiple documents", () => {
      index.addDocument("doc1", "hello world")
      index.addDocument("doc2", "goodbye world")
      expect(index.size()).toBe(2)
    })

    it("handles empty content", () => {
      index.addDocument("doc1", "")
      expect(index.size()).toBe(1)
    })

    it("replaces an existing document without corrupting document frequencies", () => {
      index.addDocument("doc1", "old exclusive")
      index.addDocument("doc1", "new replacement")
      expect(index.search("old")).toEqual([])
      expect(index.search("new")).toHaveLength(1)
    })
  })

  describe("removeDocument", () => {
    it("removes a document from the index", () => {
      index.addDocument("doc1", "hello world")
      index.removeDocument("doc1")
      expect(index.size()).toBe(0)
      expect(index.hasDocument("doc1")).toBe(false)
    })

    it("handles removing non-existent document", () => {
      index.removeDocument("nonexistent")
      expect(index.size()).toBe(0)
    })
  })

  describe("search", () => {
    beforeEach(() => {
      index.addDocument("doc1", "The quick brown fox jumps over the lazy dog")
      index.addDocument("doc2", "A quick brown dog runs in the park")
      index.addDocument("doc3", "The cat sleeps on the mat")
    })

    it("returns relevant results for a query", () => {
      const results = index.search("quick brown", 5)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].score).toBeGreaterThan(0)
    })

    it("ranks documents by relevance", () => {
      const results = index.search("quick brown", 5)
      // doc1 and doc2 both have "quick brown", doc3 has neither
      const doc1Index = results.findIndex((r) => r.id === "doc1")
      const doc2Index = results.findIndex((r) => r.id === "doc2")
      const doc3Index = results.findIndex((r) => r.id === "doc3")

      expect(doc1Index).toBeLessThan(doc3Index === -1 ? Infinity : doc3Index)
      expect(doc2Index).toBeLessThan(doc3Index === -1 ? Infinity : doc3Index)
    })

    it("returns empty results for unmatched query", () => {
      const results = index.search("elephant zebra", 5)
      expect(results.length).toBe(0)
    })

    it("respects topK limit", () => {
      const results = index.search("the", 2)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it("handles empty query", () => {
      const results = index.search("", 5)
      expect(results.length).toBe(0)
    })
  })

  describe("clear", () => {
    it("clears all documents", () => {
      index.addDocument("doc1", "hello world")
      index.addDocument("doc2", "goodbye world")
      index.clear()
      expect(index.size()).toBe(0)
    })
  })

  it("round-trips a deterministic content-free snapshot", () => {
    index.addDocument("doc-b", "中文 retrieval retrieval")
    index.addDocument("doc-a", "memory lifecycle")
    const snapshot = index.exportSnapshot()
    const restored = BM25Index.fromSnapshot(snapshot)

    expect(snapshot.documents.map((document) => document.id)).toEqual(["doc-a", "doc-b"])
    expect(JSON.stringify(snapshot)).not.toContain("中文 retrieval retrieval")
    expect(restored.search("retrieval")).toEqual(index.search("retrieval"))
  })
})

describe("reciprocalRankFusion", () => {
  it("combines multiple ranked lists", () => {
    const list1 = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.8 },
      { id: "c", score: 0.7 },
    ]
    const list2 = [
      { id: "b", score: 0.95 },
      { id: "a", score: 0.85 },
      { id: "d", score: 0.75 },
    ]

    const result = reciprocalRankFusion([list1, list2])

    expect(result.length).toBe(4) // a, b, c, d
    expect(result.map((r) => r.id)).toContain("a")
    expect(result.map((r) => r.id)).toContain("b")
    expect(result.map((r) => r.id)).toContain("c")
    expect(result.map((r) => r.id)).toContain("d")
  })

  it("applies weights correctly", () => {
    const list1 = [{ id: "a", score: 0.9 }]
    const list2 = [{ id: "b", score: 0.9 }]

    const _resultEqualWeights = reciprocalRankFusion([list1, list2], [0.5, 0.5])
    const resultUnequalWeights = reciprocalRankFusion([list1, list2], [0.9, 0.1])

    // With unequal weights, 'a' should have higher score
    const aScoreUnequal = resultUnequalWeights.find((r) => r.id === "a")?.score || 0
    const bScoreUnequal = resultUnequalWeights.find((r) => r.id === "b")?.score || 0
    expect(aScoreUnequal).toBeGreaterThan(bScoreUnequal)
  })

  it("handles empty lists", () => {
    const result = reciprocalRankFusion([[], []])
    expect(result.length).toBe(0)
  })

  it("handles single list", () => {
    const list = [{ id: "a", score: 0.9 }]
    const result = reciprocalRankFusion([list])
    expect(result.length).toBe(1)
    expect(result[0].id).toBe("a")
  })
})

describe("normalizeScores", () => {
  it("normalizes scores to 0-1 range", () => {
    const results = [
      { id: "a", score: 100 },
      { id: "b", score: 50 },
      { id: "c", score: 0 },
    ]

    const normalized = normalizeScores(results)

    expect(normalized.find((r) => r.id === "a")?.score).toBe(1)
    expect(normalized.find((r) => r.id === "c")?.score).toBe(0)
    expect(normalized.find((r) => r.id === "b")?.score).toBe(0.5)
  })

  it("handles single result", () => {
    const results = [{ id: "a", score: 50 }]
    const normalized = normalizeScores(results)
    expect(normalized[0].score).toBe(1)
  })

  it("handles empty array", () => {
    const normalized = normalizeScores([])
    expect(normalized.length).toBe(0)
  })

  it("handles all same scores", () => {
    const results = [
      { id: "a", score: 50 },
      { id: "b", score: 50 },
    ]
    const normalized = normalizeScores(results)
    expect(normalized.every((r) => r.score === 1)).toBe(true)
  })
})

describe("deduplicateResults", () => {
  it("removes duplicates keeping highest score", () => {
    const results = [
      { id: "a", score: 0.8, content: "first" },
      { id: "a", score: 0.9, content: "second" },
      { id: "b", score: 0.7, content: "third" },
    ]

    const deduped = deduplicateResults(results)

    expect(deduped.length).toBe(2)
    const aResult = deduped.find((r) => r.id === "a")
    expect(aResult?.score).toBe(0.9)
  })

  it("handles no duplicates", () => {
    const results = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.8 },
    ]

    const deduped = deduplicateResults(results)
    expect(deduped.length).toBe(2)
  })

  it("handles empty array", () => {
    const deduped = deduplicateResults([])
    expect(deduped.length).toBe(0)
  })
})

describe("HybridSearchEngine", () => {
  let engine: HybridSearchEngine

  beforeEach(() => {
    engine = createHybridSearchEngine()
  })

  describe("addDocuments", () => {
    it("adds documents to the engine", () => {
      engine.addDocuments([
        { id: "doc1", content: "Hello world" },
        { id: "doc2", content: "Goodbye world" },
      ])

      expect(engine.size()).toBe(2)
      expect(engine.hasDocument("doc1")).toBe(true)
    })
  })

  describe("removeDocuments", () => {
    it("removes documents from the engine", () => {
      engine.addDocuments([
        { id: "doc1", content: "Hello world" },
        { id: "doc2", content: "Goodbye world" },
      ])

      engine.removeDocuments(["doc1"])

      expect(engine.size()).toBe(1)
      expect(engine.hasDocument("doc1")).toBe(false)
      expect(engine.hasDocument("doc2")).toBe(true)
    })
  })

  describe("keywordSearch", () => {
    it("performs keyword-only search", () => {
      engine.addDocuments([
        { id: "doc1", content: "The quick brown fox" },
        { id: "doc2", content: "A lazy brown dog" },
      ])

      const results = engine.keywordSearch("brown", 5)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].sources).toContain("keyword")
    })
  })

  describe("hybridSearch", () => {
    it("combines vector and keyword results", () => {
      engine.addDocuments([
        { id: "doc1", content: "Machine learning algorithms" },
        { id: "doc2", content: "Deep learning neural networks" },
      ])

      const vectorResults = [
        { id: "doc1", score: 0.9 },
        { id: "doc2", score: 0.7 },
      ]

      const results = engine.hybridSearch(vectorResults, "machine learning", 5)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].combinedScore).toBeGreaterThan(0)
    })

    it("includes sparse and late interaction sources when provided", () => {
      engine.addDocuments([
        { id: "doc1", content: "Machine learning algorithms" },
        { id: "doc2", content: "Deep learning neural networks" },
      ])

      const vectorResults = [{ id: "doc1", score: 0.9 }]
      const sparseResults = [{ id: "doc1", score: 0.8 }]
      const lateResults = [{ id: "doc1", score: 0.7 }]

      const results = engine.hybridSearch(
        vectorResults,
        "machine learning",
        5,
        sparseResults,
        lateResults
      )

      expect(results[0].sources).toEqual(expect.arrayContaining(["vector", "sparse", "late"]))
      expect(results[0].sparseScore).toBe(0.8)
      expect(results[0].lateInteractionScore).toBe(0.7)
    })
  })

  describe("clear", () => {
    it("clears all documents", () => {
      engine.addDocuments([{ id: "doc1", content: "Hello world" }])

      engine.clear()
      expect(engine.size()).toBe(0)
    })
  })
})

describe("createHybridSearchEngine", () => {
  it("creates engine with initial documents", () => {
    const engine = createHybridSearchEngine([{ id: "doc1", content: "Test content" }])

    expect(engine.size()).toBe(1)
  })

  it("creates engine with custom config", () => {
    const engine = createHybridSearchEngine([], {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
    })

    expect(engine).toBeDefined()
  })
})
