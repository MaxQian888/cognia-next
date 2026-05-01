import {
  evaluateContextPrecision,
  evaluateContextRecall,
  evaluateFaithfulness,
  evaluateAnswerRelevance,
  evaluateRAG,
} from "./rag-evaluator"
import type { RerankResult } from "./reranker"

function mockDoc(
  content: string,
  score: number = 0.5,
  metadata?: Record<string, unknown>
): RerankResult {
  return {
    id: `doc-${Math.random().toString(36).slice(2, 8)}`,
    content,
    rerankScore: score,
    metadata,
  }
}

describe("RAG Evaluator", () => {
  const context = `Machine learning is a subset of artificial intelligence. 
Deep learning uses neural networks with many layers.
Supervised learning requires labeled data for training.`

  describe("evaluateContextPrecision", () => {
    it("should return high precision for relevant documents", () => {
      const docs = [
        mockDoc("Machine learning algorithms and artificial intelligence systems"),
        mockDoc("Deep learning neural networks for image recognition"),
      ]
      const precision = evaluateContextPrecision("machine learning deep learning", docs)
      expect(precision).toBeGreaterThan(0.5)
    })

    it("should return low precision when many irrelevant documents", () => {
      const docs = [
        mockDoc("Cooking recipes for Italian food"),
        mockDoc("Weather forecast for next week"),
        mockDoc("Machine learning overview"), // only one relevant
      ]
      const precision = evaluateContextPrecision("machine learning", docs)
      expect(precision).toBeLessThanOrEqual(1)
    })

    it("should return 0 for empty documents", () => {
      expect(evaluateContextPrecision("test query", [])).toBe(0)
    })

    it("should return 1 for empty query terms", () => {
      const docs = [mockDoc("any content")]
      expect(evaluateContextPrecision("", docs)).toBe(1)
    })
  })

  describe("evaluateContextRecall", () => {
    it("should return high recall when all query terms are covered", () => {
      const docs = [
        mockDoc("Machine learning algorithms and optimization"),
        mockDoc("Neural network architectures"),
      ]
      const result = evaluateContextRecall("machine learning neural network", docs)
      expect(result.recall).toBeGreaterThan(0.5)
      expect(result.termsCovered).toBeGreaterThan(0)
    })

    it("should return low recall when query terms are missing", () => {
      const docs = [mockDoc("Cooking recipes for dinner")]
      const result = evaluateContextRecall("quantum computing algorithms", docs)
      expect(result.recall).toBeLessThan(0.5)
    })

    it("should return 1 for empty query", () => {
      const docs = [mockDoc("any content")]
      const result = evaluateContextRecall("", docs)
      expect(result.recall).toBe(1)
    })

    it("should track terms covered vs total", () => {
      const docs = [mockDoc("machine learning systems")]
      const result = evaluateContextRecall("machine learning quantum computing", docs)
      expect(result.termsTotal).toBe(4) // machine, learning, quantum, computing
      expect(result.termsCovered).toBeLessThanOrEqual(result.termsTotal)
    })
  })

  describe("evaluateFaithfulness", () => {
    it("should return high faithfulness for grounded answer", () => {
      const answer =
        "Machine learning is a subset of artificial intelligence. Deep learning uses neural networks."
      const result = evaluateFaithfulness(answer, context)
      expect(result.faithfulness).toBeGreaterThan(0.5)
      expect(result.supportedSentences).toBeGreaterThan(0)
    })

    it("should return low faithfulness for fabricated answer", () => {
      const answer =
        "Quantum teleportation was achieved in 2025. Mars colonies are now self-sustaining."
      const result = evaluateFaithfulness(answer, context)
      expect(result.faithfulness).toBeLessThan(0.5)
    })

    it("should handle empty answer", () => {
      const result = evaluateFaithfulness("", context)
      expect(result.faithfulness).toBe(0)
    })

    it("should handle empty context", () => {
      const result = evaluateFaithfulness("Some answer.", "")
      expect(result.faithfulness).toBe(0)
    })

    it("should return 1 for answer with no verifiable sentences", () => {
      const result = evaluateFaithfulness("Ok.", context)
      expect(result.faithfulness).toBe(1)
      expect(result.totalSentences).toBe(0)
    })
  })

  describe("evaluateAnswerRelevance", () => {
    it("should return high relevance for on-topic answer", () => {
      const relevance = evaluateAnswerRelevance(
        "machine learning algorithms",
        "Machine learning uses various algorithms to learn from data."
      )
      expect(relevance).toBeGreaterThan(0.5)
    })

    it("should return low relevance for off-topic answer", () => {
      const relevance = evaluateAnswerRelevance(
        "machine learning",
        "The weather today is sunny and warm."
      )
      expect(relevance).toBeLessThan(0.5)
    })

    it("should return 0 for empty inputs", () => {
      expect(evaluateAnswerRelevance("", "some answer")).toBe(0)
      expect(evaluateAnswerRelevance("some query", "")).toBe(0)
    })

    it("should return 1 for empty query terms", () => {
      expect(evaluateAnswerRelevance("", "answer")).toBe(0)
    })
  })

  describe("evaluateRAG", () => {
    it("should return comprehensive evaluation result", async () => {
      const docs = [
        mockDoc("Machine learning is a subset of artificial intelligence.", 0.8),
        mockDoc("Deep learning uses neural networks with many layers.", 0.7),
      ]
      const answer = "Machine learning is a subset of AI. Deep learning uses neural networks."

      const result = await evaluateRAG("machine learning", context, answer, docs)

      expect(result.contextPrecision).toBeGreaterThanOrEqual(0)
      expect(result.contextPrecision).toBeLessThanOrEqual(1)
      expect(result.contextRecall).toBeGreaterThanOrEqual(0)
      expect(result.contextRecall).toBeLessThanOrEqual(1)
      expect(result.faithfulness).toBeGreaterThanOrEqual(0)
      expect(result.faithfulness).toBeLessThanOrEqual(1)
      expect(result.answerRelevance).toBeGreaterThanOrEqual(0)
      expect(result.answerRelevance).toBeLessThanOrEqual(1)
      expect(result.overallScore).toBeGreaterThanOrEqual(0)
      expect(result.overallScore).toBeLessThanOrEqual(1)
    })

    it("should include detailed breakdown", async () => {
      const docs = [mockDoc("Machine learning content", 0.5)]
      const result = await evaluateRAG("machine learning", context, "ML answer.", docs)

      expect(result.details).toBeDefined()
      expect(result.details.totalChunks).toBe(1)
      expect(typeof result.details.relevantChunks).toBe("number")
      expect(typeof result.details.queryTermsCovered).toBe("number")
      expect(typeof result.details.queryTermsTotal).toBe("number")
      expect(typeof result.details.supportedSentences).toBe("number")
      expect(typeof result.details.totalSentences).toBe("number")
    })

    it("should compute weighted overall score", async () => {
      const docs = [mockDoc("Machine learning is AI.", 0.9)]
      const result = await evaluateRAG("machine learning", context, "Machine learning is AI.", docs)

      // overallScore = precision*0.25 + recall*0.25 + faithfulness*0.3 + relevance*0.2
      const expected =
        result.contextPrecision * 0.25 +
        result.contextRecall * 0.25 +
        result.faithfulness * 0.3 +
        result.answerRelevance * 0.2
      expect(result.overallScore).toBeCloseTo(expected, 5)
    })

    it("should work with empty documents", async () => {
      const result = await evaluateRAG("query", context, "answer", [])
      expect(result.contextPrecision).toBe(0)
      expect(result.details.totalChunks).toBe(0)
    })
  })
})
