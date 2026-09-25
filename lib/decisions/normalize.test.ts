import type { DecisionQuestions } from "@/types/decisions"
import {
  normalizeDecisionAnswers,
  normalizeDecisionRouting,
  normalizeDecisionTruncation,
  scoreFraction,
} from "./normalize"

const questions: DecisionQuestions = {
  tense: { type: "noul", instructions: "?" },
  intent: { type: "choice", instructions: "?", criteria: { chat: "c", ask: "a", vent: "v" } },
  danger: { type: "score", instructions: "?", criteria: ["0", "1", "2", "3"] },
}

describe("normalizeDecisionAnswers", () => {
  it("reads laya/TypeSafe shaped answers", () => {
    const answers = normalizeDecisionAnswers(
      {
        tense: { type: "noul", noul: 0.82, confidence: 0.82, action: { act_probability: 1 } },
        intent: {
          type: "choice",
          choice: "vent",
          probabilities: { chat: 0.1, ask: 0.2, vent: 0.7 },
          confidence: 0.5,
        },
        danger: { type: "score", score: 2.4, confidence: 0.3, legend: { "0": "x" } },
      },
      questions
    )
    expect(answers).toEqual({
      tense: { type: "noul", noul: 0.82, confidence: 0.82 },
      intent: {
        type: "choice",
        choice: "vent",
        probabilities: { chat: 0.1, ask: 0.2, vent: 0.7 },
        confidence: 0.5,
      },
      danger: { type: "score", score: 2.4, levels: 4, confidence: 0.3 },
    })
  })

  it("tolerates stringified numbers and clamps ranges", () => {
    const answers = normalizeDecisionAnswers(
      { tense: { noul: "1.4" }, danger: { score: 9, probabilities: { "0": "0.5", "7": 1 } } },
      questions
    )
    expect(answers.tense).toEqual({ type: "noul", noul: 1 })
    expect(answers.danger).toEqual({
      type: "score",
      score: 3,
      levels: 4,
      confidence: 0,
      probabilities: { "0": 0.5 },
    })
  })

  it("falls back to the probability argmax when the choice key is foreign", () => {
    const answers = normalizeDecisionAnswers(
      { intent: { choice: "other", probabilities: { chat: 0.2, ask: 0.6 } } },
      questions
    )
    expect(answers.intent).toMatchObject({ choice: "ask", confidence: 0.6 })
  })

  it("drops unreadable answers instead of inventing a verdict", () => {
    const answers = normalizeDecisionAnswers(
      { tense: { noul: "n/a" }, intent: { choice: "other" }, danger: "3", extra: { noul: 1 } },
      questions
    )
    expect(answers).toEqual({})
    expect(normalizeDecisionAnswers(null, questions)).toEqual({})
  })
})

describe("routing / truncation", () => {
  it("keeps model + reason only", () => {
    expect(
      normalizeDecisionRouting({ model: "multilingual", reason: "han", detection: {} })
    ).toEqual({ model: "multilingual", reason: "han" })
    expect(normalizeDecisionRouting({ reason: "x" })).toBeUndefined()
  })

  it("keeps well-formed truncation entries for asked questions", () => {
    expect(
      normalizeDecisionTruncation(
        {
          tense: { instructionTokens: 40, instructionTokensKept: 16, optionsClipped: 1 },
          intent: { instructionTokens: "x" },
          ghost: { instructionTokens: 1, instructionTokensKept: 1, optionsClipped: 0 },
        },
        questions
      )
    ).toEqual({ tense: { instructionTokens: 40, instructionTokensKept: 16, optionsClipped: 1 } })
    expect(normalizeDecisionTruncation(undefined, questions)).toBeUndefined()
  })
})

describe("scoreFraction", () => {
  it("maps the expected level onto 0..1", () => {
    expect(scoreFraction({ score: 1.5, levels: 4 })).toBeCloseTo(0.5)
    expect(scoreFraction({ score: 3, levels: 1 })).toBe(0)
  })
})
