import {
  gradeDocumentHeuristic,
  gradeRetrievedDocuments,
  isRetrievalSufficient,
} from "./retrieval-grader"
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

describe("Retrieval Grader", () => {
  describe("gradeDocumentHeuristic", () => {
    it("should give high grade for documents with good term overlap", () => {
      const doc = mockDoc(
        "Machine learning is a subset of artificial intelligence that focuses on algorithms",
        0.8
      )
      const grade = gradeDocumentHeuristic("machine learning algorithms", doc)
      expect(grade).toBeGreaterThan(0.4)
    })

    it("should give low grade for irrelevant documents", () => {
      const doc = mockDoc("The weather today is sunny and warm with a light breeze", 0.1)
      const grade = gradeDocumentHeuristic("machine learning algorithms", doc)
      expect(grade).toBeLessThan(0.3)
    })

    it("should give bonus for exact phrase match", () => {
      const doc = mockDoc("machine learning is very important", 0.5)
      const gradeWithPhrase = gradeDocumentHeuristic("machine learning", doc)

      const doc2 = mockDoc("learning about machines in school", 0.5)
      const gradeWithoutPhrase = gradeDocumentHeuristic("machine learning", doc2)

      expect(gradeWithPhrase).toBeGreaterThan(gradeWithoutPhrase)
    })

    it("should penalize very short documents", () => {
      const shortDoc = mockDoc("short", 0.5)
      const longDoc = mockDoc(
        "This is a longer document about the topic of interest with more content",
        0.5
      )
      const shortGrade = gradeDocumentHeuristic("topic", shortDoc)
      const longGrade = gradeDocumentHeuristic("topic", longDoc)
      expect(longGrade).toBeGreaterThanOrEqual(shortGrade)
    })

    it("should give bonus for title metadata match", () => {
      const docWithTitle = mockDoc("Some content about algorithms", 0.5, {
        title: "Machine Learning Guide",
      })
      const docWithoutTitle = mockDoc("Some content about algorithms", 0.5)
      const gradeWithTitle = gradeDocumentHeuristic("machine learning", docWithTitle)
      const gradeWithoutTitle = gradeDocumentHeuristic("machine learning", docWithoutTitle)
      expect(gradeWithTitle).toBeGreaterThanOrEqual(gradeWithoutTitle)
    })

    it("should return neutral grade for empty query terms", () => {
      const doc = mockDoc("Some content", 0.5)
      const grade = gradeDocumentHeuristic("", doc)
      expect(grade).toBeCloseTo(0.5, 0)
    })

    it("should clamp grade between 0 and 1", () => {
      const doc = mockDoc(
        "machine learning deep learning AI neural networks algorithms optimization training",
        1.0,
        { title: "Machine Learning" }
      )
      const grade = gradeDocumentHeuristic("machine learning", doc)
      expect(grade).toBeGreaterThanOrEqual(0)
      expect(grade).toBeLessThanOrEqual(1)
    })
  })

  describe("gradeRetrievedDocuments", () => {
    it("should filter irrelevant documents", async () => {
      const docs = [
        mockDoc("Machine learning algorithms and optimization techniques", 0.8),
        mockDoc("The weather forecast for tomorrow shows rain", 0.2),
        mockDoc("Deep learning neural networks for classification", 0.7),
      ]

      const result = await gradeRetrievedDocuments("machine learning algorithms", docs, {
        relevanceThreshold: 0.3,
      })

      expect(result.relevantDocuments.length).toBeLessThanOrEqual(docs.length)
      expect(result.stats.totalGraded).toBe(3)
      expect(result.stats.totalFiltered).toBeGreaterThanOrEqual(0)
    })

    it("should use keep_best fallback when too few results pass", async () => {
      const docs = [
        mockDoc("Unrelated document about cooking recipes", 0.1),
        mockDoc("Another unrelated document about sports", 0.1),
      ]

      const result = await gradeRetrievedDocuments("quantum computing", docs, {
        relevanceThreshold: 0.9,
        fallbackStrategy: "keep_best",
        minChunks: 1,
      })

      expect(result.stats.fallbackUsed).toBe(true)
      expect(result.relevantDocuments.length).toBeGreaterThanOrEqual(1)
    })

    it("should respect relax_threshold fallback", async () => {
      const docs = [mockDoc("Some computing content with quantum mentions", 0.3)]

      const result = await gradeRetrievedDocuments("quantum computing", docs, {
        relevanceThreshold: 0.9,
        fallbackStrategy: "relax_threshold",
        minChunks: 1,
      })

      expect(result.stats.fallbackUsed).toBe(true)
    })

    it("should return empty with none fallback strategy", async () => {
      const docs = [mockDoc("Completely unrelated content", 0.05)]

      const result = await gradeRetrievedDocuments("quantum computing", docs, {
        relevanceThreshold: 0.99,
        fallbackStrategy: "none",
        minChunks: 1,
      })

      expect(result.stats.fallbackUsed).toBe(true)
      expect(result.relevantDocuments.length).toBe(0)
    })

    it("should limit documents graded to maxChunksToGrade", async () => {
      const docs = Array.from({ length: 30 }, (_, i) =>
        mockDoc(`Document content ${i} about machine learning`, 0.5)
      )

      const result = await gradeRetrievedDocuments("machine learning", docs, {
        maxChunksToGrade: 10,
      })

      expect(result.stats.totalGraded).toBe(10)
    })

    it("should sort relevant documents by grade descending", async () => {
      const docs = [
        mockDoc("Machine learning deep learning algorithms", 0.9),
        mockDoc("Machine learning overview", 0.5),
        mockDoc("Advanced machine learning techniques for optimization", 0.8),
      ]

      const result = await gradeRetrievedDocuments("machine learning", docs, {
        relevanceThreshold: 0.1,
      })

      for (let i = 1; i < result.allDocuments.length; i++) {
        expect(result.allDocuments[i - 1].grade).toBeGreaterThanOrEqual(0)
      }
    })

    it("should report correct method", async () => {
      const docs = [mockDoc("Test content", 0.5)]
      const result = await gradeRetrievedDocuments("test", docs)
      expect(result.stats.method).toBe("heuristic")
    })
  })

  describe("isRetrievalSufficient", () => {
    it("should return true when enough relevant documents", () => {
      const docs = [
        mockDoc("Machine learning algorithms for data science", 0.8),
        mockDoc("Deep learning neural network training methods", 0.7),
      ]
      expect(
        isRetrievalSufficient("machine learning", docs, { threshold: 0.3, minRelevant: 2 })
      ).toBe(true)
    })

    it("should return false when not enough relevant documents", () => {
      const docs = [mockDoc("Cooking recipes for dinner", 0.1)]
      expect(
        isRetrievalSufficient("machine learning", docs, { threshold: 0.5, minRelevant: 2 })
      ).toBe(false)
    })

    it("should use default parameters", () => {
      const docs = [mockDoc("Machine learning is great", 0.8)]
      expect(isRetrievalSufficient("machine learning", docs)).toBe(true)
    })
  })
})
