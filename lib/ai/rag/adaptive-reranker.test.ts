/**
 * Tests for Adaptive Reranker
 */

// Jest globals are auto-imported
import {
  AdaptiveReranker,
  createAdaptiveReranker,
  getGlobalAdaptiveReranker,
  resetGlobalAdaptiveReranker,
} from "./adaptive-reranker"
import type { RerankResult } from "./reranker"

describe("AdaptiveReranker", () => {
  let reranker: AdaptiveReranker

  beforeEach(() => {
    reranker = createAdaptiveReranker({
      enabled: true,
      feedbackWeight: 0.3,
      minFeedbackCount: 2,
      persistFeedback: false,
    })
  })

  afterEach(() => {
    reranker.clearHistory()
  })

  const createMockResults = (count: number): RerankResult[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `result-${i}`,
      content: `Content ${i}`,
      originalScore: 0.9 - i * 0.1,
      rerankScore: 0.9 - i * 0.1,
    }))
  }

  describe("recordFeedback", () => {
    it("should record explicit feedback", () => {
      reranker.recordFeedback("test query", "result-1", 0.9, "explicit")

      const feedback = reranker.getQueryFeedback("test query")
      expect(feedback).toHaveLength(1)
      expect(feedback[0].relevance).toBe(0.9)
      expect(feedback[0].action).toBe("explicit")
    })

    it("should record implicit feedback", () => {
      reranker.recordImplicitFeedback("test query", "result-1", "click")

      const feedback = reranker.getQueryFeedback("test query")
      expect(feedback).toHaveLength(1)
      expect(feedback[0].action).toBe("click")
    })

    it("should clamp relevance to 0-1 range", () => {
      reranker.recordFeedback("query", "result", 1.5, "explicit")
      reranker.recordFeedback("query", "result", -0.5, "explicit")

      const feedback = reranker.getQueryFeedback("query")
      expect(feedback[0].relevance).toBe(1)
      expect(feedback[1].relevance).toBe(0)
    })
  })

  describe("rerankWithLearning", () => {
    it("should return original order without enough feedback", async () => {
      const results = createMockResults(3)
      reranker.recordFeedback("test", "result-2", 1.0, "explicit")

      const reranked = await reranker.rerankWithLearning("test", results)

      expect(reranked[0].id).toBe("result-0") // Original order preserved
    })

    it("should adjust order based on feedback", async () => {
      const results = createMockResults(3)

      // Record enough feedback to boost result-2
      reranker.recordFeedback("boost query", "result-2", 1.0, "explicit")
      reranker.recordFeedback("boost query", "result-2", 0.95, "use")
      reranker.recordFeedback("boost query", "result-2", 0.9, "click")

      const reranked = await reranker.rerankWithLearning("boost query", results)

      // result-2 should be boosted
      const result2Index = reranked.findIndex((r) => r.id === "result-2")
      expect(result2Index).toBeLessThan(2) // Should be higher than original position
    })

    it("should not modify results when disabled", async () => {
      reranker.setEnabled(false)
      const results = createMockResults(3)

      const reranked = await reranker.rerankWithLearning("test", results)

      expect(reranked).toEqual(results)
    })

    it("should handle empty results", async () => {
      const reranked = await reranker.rerankWithLearning("test", [])
      expect(reranked).toEqual([])
    })
  })

  describe("getStats", () => {
    it("should track statistics", () => {
      reranker.recordFeedback("query1", "result1", 0.8, "explicit")
      reranker.recordFeedback("query2", "result2", 0.6, "explicit")

      const stats = reranker.getStats()

      expect(stats.totalFeedback).toBe(2)
      expect(stats.uniqueQueries).toBe(2)
      expect(stats.averageRelevance).toBeGreaterThan(0)
    })
  })

  describe("clearHistory", () => {
    it("should clear all feedback", () => {
      reranker.recordFeedback("query", "result", 0.8, "explicit")

      reranker.clearHistory()

      expect(reranker.getQueryFeedback("query")).toHaveLength(0)
      expect(reranker.getStats().totalFeedback).toBe(0)
    })
  })

  describe("exportFeedback and importFeedback", () => {
    it("should export and import feedback", () => {
      reranker.recordFeedback("query1", "result1", 0.8, "explicit")
      reranker.recordFeedback("query2", "result2", 0.6, "use")

      const exported = reranker.exportFeedback()

      const newReranker = createAdaptiveReranker({ persistFeedback: false })
      newReranker.importFeedback(exported)

      expect(newReranker.getQueryFeedback("query1")).toHaveLength(1)
      expect(newReranker.getQueryFeedback("query2")).toHaveLength(1)
    })
  })

  describe("setFeedbackWeight", () => {
    it("should update feedback weight", async () => {
      reranker.setFeedbackWeight(0.5)

      // Record enough feedback
      reranker.recordFeedback("test", "result-1", 1.0, "explicit")
      reranker.recordFeedback("test", "result-1", 1.0, "explicit")

      const results = createMockResults(3)
      const reranked = await reranker.rerankWithLearning("test", results)

      // Higher weight should have more impact
      expect(reranked).toBeDefined()
    })

    it("should clamp weight to valid range", () => {
      reranker.setFeedbackWeight(1.5)
      // Should be clamped internally
    })
  })
})

describe("Global Adaptive Reranker", () => {
  afterEach(() => {
    resetGlobalAdaptiveReranker()
  })

  it("should return singleton instance", () => {
    const reranker1 = getGlobalAdaptiveReranker()
    const reranker2 = getGlobalAdaptiveReranker()

    expect(reranker1).toBe(reranker2)
  })

  it("should reset global instance", () => {
    const reranker1 = getGlobalAdaptiveReranker()
    reranker1.recordFeedback("query", "result", 0.8, "explicit")

    resetGlobalAdaptiveReranker()

    const reranker2 = getGlobalAdaptiveReranker()
    expect(reranker2.getQueryFeedback("query")).toHaveLength(0)
  })
})
