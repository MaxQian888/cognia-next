// Only the generation is faked; the rest of the SDK (e.g. `cosineSimilarity`)
// stays real, as other package modules use it.
jest.mock("ai", () => ({ ...jest.requireActual("ai"), generateText: jest.fn() }))

import { generateText } from "ai"
import type { LanguageModel } from "ai"
import type { GenerationRequest, GenerationSend } from "@cognia/provider-embedding/generation-seam"

/**
 * Tests for Query Expansion Module
 */

import {
  extractKeywords,
  generateHypotheticalAnswer,
  generateStepBackQuery,
  decomposeQuery,
  expandQuery,
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

// --- Generation seam (ADR-0188 D27) ------------------------------------------
// The host injects `generate` when its ledger surface is on; with nothing
// injected the model is called exactly as it always was.

const mockedGenerateText = generateText as jest.Mock
const seamModel = { modelId: "m-1" } as unknown as LanguageModel

/** A seam that reserves the call: it bounds the output and kills SDK retries. */
function boundingSeam() {
  const requests: GenerationRequest[] = []
  const seam = async (request: GenerationRequest, send: GenerationSend) => {
    requests.push(request)
    return (await send({ maxOutputTokens: 64, maxRetries: 0 })).text
  }
  return { seam, requests }
}

/** The keys of the one `generateText` call, sorted. */
function callKeys(): string[] {
  return Object.keys(mockedGenerateText.mock.calls[0][0] as Record<string, unknown>).sort()
}

describe("query expansion generation seam", () => {
  beforeEach(() => {
    mockedGenerateText.mockReset()
    mockedGenerateText.mockResolvedValue({ text: "a broader question" })
  })

  it("calls the model directly when no seam is injected", async () => {
    await expect(generateStepBackQuery("why is the sky blue", seamModel)).resolves.toBe(
      "a broader question"
    )
    expect(callKeys()).toEqual(["model", "prompt", "temperature"])
  })

  it("runs the step-back call through an injected seam, which bounds it", async () => {
    const { seam, requests } = boundingSeam()
    await generateStepBackQuery("why is the sky blue", seamModel, { generate: seam })
    expect(requests[0]).toMatchObject({ stage: "rag.step-back", modelId: "m-1", temperature: 0.3 })
    expect(mockedGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 64, maxRetries: 0 })
    )
  })

  it("runs HyDE and decomposition through the seam too", async () => {
    const { seam, requests } = boundingSeam()
    await generateHypotheticalAnswer("q", seamModel, { generate: seam })
    mockedGenerateText.mockResolvedValue({ text: '["a", "b"]' })
    await decomposeQuery("q", seamModel, { generate: seam })
    expect(requests.map((r) => r.stage)).toEqual(["rag.hyde", "rag.decompose"])
  })

  it("threads the config's seam through every stage of expandQuery", async () => {
    mockedGenerateText.mockResolvedValue({ text: '["variant one"]' })
    const { seam, requests } = boundingSeam()
    await expandQuery("query terms", {
      model: seamModel,
      includeHypotheticalAnswer: true,
      generate: seam,
    })
    expect(requests.map((r) => r.stage)).toEqual(["rag.query-variants", "rag.hyde", "rag.rewrite"])
  })
})
