import { checkGroundingHeuristic, checkAnswerGrounding, isAnswerGrounded } from "./answer-grounding"

describe("Answer Grounding", () => {
  const context = `Machine learning is a subset of artificial intelligence that focuses on building systems 
that learn from data. Deep learning uses neural networks with many layers. 
Supervised learning requires labeled training data. Unsupervised learning discovers patterns 
without labels. Reinforcement learning uses reward signals to guide behavior.`

  describe("checkGroundingHeuristic", () => {
    it("should mark grounded answer as grounded", () => {
      const answer =
        "Machine learning is a subset of artificial intelligence that learns from data."
      const result = checkGroundingHeuristic(answer, context)
      expect(result.isGrounded).toBe(true)
      expect(result.confidence).toBeGreaterThan(0.5)
      expect(result.method).toBe("heuristic")
    })

    it("should detect ungrounded claims", () => {
      const answer =
        "Machine learning was invented in 2020 by Google and requires quantum computers to function properly."
      const result = checkGroundingHeuristic(answer, context)
      expect(result.unsupportedClaims.length).toBeGreaterThan(0)
    })

    it("should handle answer with all supported claims", () => {
      const answer =
        "Deep learning uses neural networks. Supervised learning requires labeled training data."
      const result = checkGroundingHeuristic(answer, context)
      expect(result.isGrounded).toBe(true)
      expect(result.supportedClaims.length).toBeGreaterThan(0)
    })

    it("should handle empty answer", () => {
      const result = checkGroundingHeuristic("", context)
      expect(result.isGrounded).toBe(true)
      expect(result.confidence).toBe(1)
    })

    it("should handle answer with no verifiable claims (short sentences)", () => {
      const result = checkGroundingHeuristic("Yes.", context)
      expect(result.isGrounded).toBe(true)
    })

    it("should handle generic prefix sentences", () => {
      const answer =
        "Based on the context, machine learning uses neural networks for deep learning."
      const result = checkGroundingHeuristic(answer, context)
      expect(result.supportedClaims.length).toBeGreaterThan(0)
    })
  })

  describe("checkAnswerGrounding", () => {
    it("should use heuristic by default", async () => {
      const answer = "Machine learning learns from data using algorithms."
      const result = await checkAnswerGrounding(answer, context)
      expect(result.method).toBe("heuristic")
      expect(result.isGrounded).toBeDefined()
    })

    it("should handle empty answer", async () => {
      const result = await checkAnswerGrounding("", context)
      expect(result.isGrounded).toBe(true)
      expect(result.confidence).toBe(1)
    })

    it("should handle empty context", async () => {
      const result = await checkAnswerGrounding("Some answer here.", "")
      expect(result.isGrounded).toBe(false)
      expect(result.confidence).toBe(0)
    })

    it("should handle both empty", async () => {
      const result = await checkAnswerGrounding("", "")
      expect(result.isGrounded).toBe(true)
    })

    it("should respect maxAnswerLength", async () => {
      const longAnswer = "Machine learning ".repeat(1000)
      const result = await checkAnswerGrounding(longAnswer, context, {
        maxAnswerLength: 100,
      })
      expect(result).toBeDefined()
    })
  })

  describe("isAnswerGrounded", () => {
    it("should return true for grounded answer", () => {
      const answer = "Machine learning is a subset of artificial intelligence."
      expect(isAnswerGrounded(answer, context)).toBe(true)
    })

    it("should return false for ungrounded answer with high threshold", () => {
      const answer =
        "Quantum computing solves NP-complete problems instantly using entanglement and superposition."
      expect(isAnswerGrounded(answer, context, 0.9)).toBe(false)
    })

    it("should respect custom threshold", () => {
      const answer = "Machine learning is a type of AI."
      expect(isAnswerGrounded(answer, context, 0.01)).toBe(true)
    })
  })
})
