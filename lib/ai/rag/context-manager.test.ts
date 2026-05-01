/**
 * Tests for Dynamic Context Manager
 */

// Jest globals are auto-imported
import {
  DynamicContextManager,
  createContextManager,
  getModelContextLimits,
} from "./context-manager"
import type { RerankResult } from "./reranker"

describe("DynamicContextManager", () => {
  let manager: DynamicContextManager

  beforeEach(() => {
    manager = createContextManager({
      maxTokens: 8000,
      minChunks: 1,
      maxChunks: 10,
      reserveTokens: 2000,
      charsPerToken: 4,
    })
  })

  const createMockResults = (count: number, contentLength: number = 500): RerankResult[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `doc-${i}`,
      content: "A".repeat(contentLength),
      metadata: {
        source: `source-${i}`,
        documentTitle: `Title ${i}`,
      },
      originalScore: 0.9 - i * 0.1,
      rerankScore: 0.9 - i * 0.1,
    }))
  }

  describe("estimateTokens", () => {
    it("should estimate tokens based on character count", () => {
      expect(manager.estimateTokens("Hello World")).toBe(3) // 11 chars / 4 = 2.75 -> 3
      expect(manager.estimateTokens("")).toBe(0)
      expect(manager.estimateTokens("A".repeat(100))).toBe(25)
    })
  })

  describe("calculateOptimalContextLength", () => {
    it("should return available tokens for complex queries", () => {
      const results = createMockResults(5)
      const query =
        "Compare and analyze the differences between approach A and approach B, explaining why one might be better than the other in various scenarios"

      const length = manager.calculateOptimalContextLength(query, results)

      expect(length).toBeGreaterThan(500)
      expect(length).toBeLessThanOrEqual(8000 - 2000) // maxTokens - reserveTokens
    })

    it("should return smaller context for simple queries", () => {
      const results = createMockResults(5)
      const simpleQuery = "What is X?"

      const length = manager.calculateOptimalContextLength(simpleQuery, results)

      expect(length).toBeLessThanOrEqual(2000)
    })

    it("should respect maxTokens parameter", () => {
      const results = createMockResults(5)
      const query = "test query"

      const length = manager.calculateOptimalContextLength(query, results, 4000)

      expect(length).toBeLessThanOrEqual(4000 - 2000)
    })
  })

  describe("selectOptimalChunks", () => {
    it("should select chunks within token budget", () => {
      const results = createMockResults(5, 200) // Each ~50 tokens

      const selection = manager.selectOptimalChunks(results, 500)

      expect(selection.chunks.length).toBeGreaterThan(0)
      expect(selection.budget.usedTokens).toBeLessThanOrEqual(500)
    })

    it("should prioritize higher scoring chunks", () => {
      const results = createMockResults(5)

      const selection = manager.selectOptimalChunks(results, 1000)

      // First chunk should have highest score
      expect(selection.chunks[0].score).toBe(0.9)
    })

    it("should truncate chunks if needed to meet minimum", () => {
      const results = createMockResults(1, 2000) // One large chunk

      const selection = manager.selectOptimalChunks(results, 100)

      expect(selection.chunks.length).toBe(1)
      expect(selection.compressionApplied).toBe(true)
    })

    it("should remove duplicate content", () => {
      const results: RerankResult[] = [
        { id: "doc-1", content: "Same content here", rerankScore: 0.9, originalScore: 0.9 },
        { id: "doc-2", content: "Same content here", rerankScore: 0.8, originalScore: 0.8 },
        { id: "doc-3", content: "Different content", rerankScore: 0.7, originalScore: 0.7 },
      ]

      const selection = manager.selectOptimalChunks(results, 1000)

      // Should have removed duplicate
      expect(selection.chunks.length).toBeLessThanOrEqual(2)
    })

    it("should format context with sources", () => {
      const results = createMockResults(2, 100)

      const selection = manager.selectOptimalChunks(results, 1000)

      expect(selection.formattedContext).toContain("[Source 1]")
      expect(selection.formattedContext).toContain("[Source 2]")
      expect(selection.formattedContext).toContain("Relevance:")
    })
  })

  describe("compressContext", () => {
    it("should not compress if within limit", () => {
      const context = "Short context"

      const result = manager.compressContext(context, 1000)

      expect(result.compressed).toBe(context)
      expect(result.compressionRatio).toBe(1)
    })

    it("should compress long context", () => {
      const context = "A".repeat(1000) // ~250 tokens

      const result = manager.compressContext(context, 50)

      expect(manager.estimateTokens(result.compressed)).toBeLessThanOrEqual(50)
      expect(result.compressionRatio).toBeLessThan(1)
    })

    it("should remove filler phrases", () => {
      const context = "It is important to note that this is basically the main point"

      // Use a token limit lower than the context length to trigger compression
      const result = manager.compressContext(context, 10)

      expect(result.compressed).not.toContain("It is important to note that")
      expect(result.compressed).not.toContain("basically")
    })
  })

  describe("updateConfig", () => {
    it("should update configuration", () => {
      manager.updateConfig({ maxTokens: 16000 })

      const config = manager.getConfig()
      expect(config.maxTokens).toBe(16000)
    })
  })
})

describe("getModelContextLimits", () => {
  it("should return correct limits for GPT-4", () => {
    const limits = getModelContextLimits("gpt-4")
    expect(limits.maxTokens).toBe(8192)
    expect(limits.reserveTokens).toBe(2000)
  })

  it("should return correct limits for GPT-4 Turbo", () => {
    const limits = getModelContextLimits("gpt-4-turbo-preview")
    expect(limits.maxTokens).toBe(128000)
  })

  it("should return correct limits for Claude", () => {
    const limits = getModelContextLimits("claude-3-opus-20240229")
    expect(limits.maxTokens).toBe(200000)
  })

  it("should return default limits for unknown models", () => {
    const limits = getModelContextLimits("unknown-model")
    expect(limits.maxTokens).toBe(100000)
    expect(limits.reserveTokens).toBe(2000)
  })
})
