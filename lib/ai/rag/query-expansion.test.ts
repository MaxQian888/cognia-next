/**
 * Tests for Query Expansion Module
 */

import {
  extractKeywords,
  generateSynonyms,
  expandWithSynonyms,
  mergeQueryResults,
} from "./query-expansion"

describe("extractKeywords", () => {
  it("extracts meaningful keywords from query", () => {
    const keywords = extractKeywords("How do I configure the database connection?")

    expect(keywords).toContain("configure")
    expect(keywords).toContain("database")
    expect(keywords).toContain("connection")
  })

  it("filters out stop words", () => {
    const keywords = extractKeywords("What is the best way to do this?")

    expect(keywords).not.toContain("what")
    expect(keywords).not.toContain("is")
    expect(keywords).not.toContain("the")
    expect(keywords).not.toContain("to")
    expect(keywords).not.toContain("this")
  })

  it("filters out short words", () => {
    const keywords = extractKeywords("I am a test")

    expect(keywords).not.toContain("I")
    expect(keywords).not.toContain("am")
    expect(keywords).not.toContain("a")
  })

  it("handles empty query", () => {
    const keywords = extractKeywords("")

    expect(keywords).toEqual([])
  })

  it("handles query with only stop words", () => {
    const keywords = extractKeywords("the is a an")

    expect(keywords.length).toBe(0)
  })

  it("removes punctuation", () => {
    const keywords = extractKeywords("Hello, world! How are you?")

    expect(keywords).toContain("hello")
    expect(keywords).toContain("world")
    expect(keywords).not.toContain("hello,")
    expect(keywords).not.toContain("world!")
  })

  it("deduplicates keywords", () => {
    const keywords = extractKeywords("test test test testing")

    const testCount = keywords.filter((k) => k === "test").length
    expect(testCount).toBe(1)
  })

  it("converts to lowercase", () => {
    const keywords = extractKeywords("Database CONNECTION Config")

    expect(keywords).toContain("database")
    expect(keywords).toContain("connection")
    expect(keywords).toContain("config")
    expect(keywords).not.toContain("Database")
  })
})

describe("generateSynonyms", () => {
  it("generates synonyms for known words", () => {
    const synonyms = generateSynonyms(["create", "delete"])

    expect(synonyms.has("create")).toBe(true)
    expect(synonyms.has("delete")).toBe(true)
    expect(synonyms.get("create")).toContain("make")
    expect(synonyms.get("delete")).toContain("remove")
  })

  it("returns empty map for unknown words", () => {
    const synonyms = generateSynonyms(["xyz123", "unknownword"])

    expect(synonyms.size).toBe(0)
  })

  it("handles empty array", () => {
    const synonyms = generateSynonyms([])

    expect(synonyms.size).toBe(0)
  })

  it("handles mixed known and unknown words", () => {
    const synonyms = generateSynonyms(["create", "xyz123", "update"])

    expect(synonyms.has("create")).toBe(true)
    expect(synonyms.has("update")).toBe(true)
    expect(synonyms.has("xyz123")).toBe(false)
  })

  it("includes common programming synonyms", () => {
    const synonyms = generateSynonyms(["api", "config", "function"])

    expect(synonyms.get("api")).toContain("interface")
    expect(synonyms.get("config")).toContain("configuration")
    expect(synonyms.get("function")).toContain("method")
  })
})

describe("expandWithSynonyms", () => {
  it("expands query with synonyms", () => {
    const expansions = expandWithSynonyms("create a new file")

    expect(expansions.length).toBeGreaterThan(1)
    expect(expansions[0]).toBe("create a new file") // Original
  })

  it("includes original query first", () => {
    const expansions = expandWithSynonyms("delete the config")

    expect(expansions[0]).toBe("delete the config")
  })

  it("generates variant with synonym substitution", () => {
    const expansions = expandWithSynonyms("create function")

    // Should have variants like "make function" or "create method"
    expect(expansions.some((e) => e.includes("make") || e.includes("method"))).toBe(true)
  })

  it("handles query with no known synonyms", () => {
    const expansions = expandWithSynonyms("xyz123 unknown terms")

    expect(expansions.length).toBe(1)
    expect(expansions[0]).toBe("xyz123 unknown terms")
  })

  it("handles empty query", () => {
    const expansions = expandWithSynonyms("")

    expect(expansions.length).toBe(1)
    expect(expansions[0]).toBe("")
  })
})

describe("mergeQueryResults", () => {
  it("merges results from multiple result sets", () => {
    const resultSets = [
      [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.8 },
      ],
      [
        { id: "b", score: 0.85 },
        { id: "c", score: 0.7 },
      ],
    ]

    const merged = mergeQueryResults(resultSets, { dedup: true })

    expect(merged.length).toBe(3) // a, b, c
  })

  it("deduplicates by ID", () => {
    const resultSets = [[{ id: "a", score: 0.9 }], [{ id: "a", score: 0.8 }]]

    const merged = mergeQueryResults(resultSets, { dedup: true })

    expect(merged.length).toBe(1)
  })

  it("aggregates scores with max by default", () => {
    const resultSets = [[{ id: "a", score: 0.7 }], [{ id: "a", score: 0.9 }]]

    const merged = mergeQueryResults(resultSets, { dedup: true, scoreAggregation: "max" })

    expect(merged[0].score).toBe(0.9)
  })

  it("aggregates scores with sum", () => {
    const resultSets = [[{ id: "a", score: 0.5 }], [{ id: "a", score: 0.3 }]]

    const merged = mergeQueryResults(resultSets, { dedup: true, scoreAggregation: "sum" })

    expect(merged[0].score).toBe(0.8)
  })

  it("aggregates scores with average", () => {
    const resultSets = [[{ id: "a", score: 0.8 }], [{ id: "a", score: 0.4 }]]

    const merged = mergeQueryResults(resultSets, { dedup: true, scoreAggregation: "avg" })

    expect(merged[0].score).toBeCloseTo(0.6)
  })

  it("respects maxResults limit", () => {
    const resultSets = [
      [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.8 },
        { id: "c", score: 0.7 },
      ],
    ]

    const merged = mergeQueryResults(resultSets, { maxResults: 2 })

    expect(merged.length).toBe(2)
  })

  it("sorts by score descending", () => {
    const resultSets = [
      [
        { id: "a", score: 0.5 },
        { id: "b", score: 0.9 },
        { id: "c", score: 0.7 },
      ],
    ]

    const merged = mergeQueryResults(resultSets)

    expect(merged[0].id).toBe("b")
    expect(merged[1].id).toBe("c")
    expect(merged[2].id).toBe("a")
  })

  it("handles empty result sets", () => {
    const merged = mergeQueryResults([[], []])

    expect(merged.length).toBe(0)
  })

  it("handles single result set", () => {
    const resultSets = [[{ id: "a", score: 0.9 }]]

    const merged = mergeQueryResults(resultSets)

    expect(merged.length).toBe(1)
    expect(merged[0].id).toBe("a")
  })

  it("preserves additional properties", () => {
    const resultSets = [[{ id: "a", score: 0.9, content: "test", metadata: { key: "value" } }]]

    const merged = mergeQueryResults(resultSets)

    expect(merged[0]).toHaveProperty("content", "test")
    expect(merged[0]).toHaveProperty("metadata")
  })

  it("without dedup, returns flat results", () => {
    const resultSets = [[{ id: "a", score: 0.9 }], [{ id: "a", score: 0.8 }]]

    const merged = mergeQueryResults(resultSets, { dedup: false })

    expect(merged.length).toBe(2)
  })
})
