import type { DecisionAnswers } from "@/types/decisions"
import { dangerTone, isEmptyJudgment, rankCandidates, toJudgment } from "./judgment"

const answers: DecisionAnswers = {
  literal_question: { type: "noul", noul: 0.2 },
  true_intent: {
    type: "choice",
    choice: "confirm_you_care",
    confidence: 0.4,
    probabilities: { confirm_you_care: 0.6, vent_anger: 0.3 },
  },
  danger_level: { type: "score", score: 4.2, levels: 10, confidence: 0.5 },
  should_reply_now: { type: "noul", noul: 0.1 },
  best_action: { type: "choice", choice: "check_history", confidence: 0.7, probabilities: {} },
  she_needs: { type: "choice", choice: "care", confidence: 0.8, probabilities: { care: 0.8 } },
  tension_resolved: { type: "noul", noul: 0.05 },
}

describe("toJudgment", () => {
  it("maps wire ids onto neutral fields", () => {
    expect(toJudgment(answers)).toEqual({
      literal: 0.2,
      intent: {
        key: "confirm_you_care",
        confidence: 0.4,
        probabilities: { confirm_you_care: 0.6, vent_anger: 0.3 },
      },
      danger: { level: 4.2, levels: 10, confidence: 0.5 },
      substanceNow: 0.1,
      bestAction: { key: "check_history", confidence: 0.7, probabilities: {} },
      need: { key: "care", confidence: 0.8, probabilities: { care: 0.8 } },
      tensionResolved: 0.05,
    })
  })

  it("drops mistyped or foreign answers instead of guessing", () => {
    const judgment = toJudgment({
      literal_question: { type: "score", score: 1, levels: 2, confidence: 0 },
      true_intent: { type: "choice", choice: "invented", confidence: 1, probabilities: {} },
    })
    expect(judgment.literal).toBeNull()
    expect(judgment.intent).toBeNull()
    expect(isEmptyJudgment(judgment)).toBe(true)
    expect(isEmptyJudgment(toJudgment(answers))).toBe(false)
  })
})

describe("dangerTone", () => {
  it.each([
    [0, "calm"],
    [2.4, "calm"],
    [3, "watch"],
    [5, "tense"],
    [6.6, "critical"],
    [9, "critical"],
  ])("level %s → %s", (level, tone) => {
    expect(dangerTone(level)).toBe(tone)
  })
})

describe("rankCandidates", () => {
  const drafts = ["稳妥", "行动", "简短"]

  it("sorts by P(best) and keeps the draft slot", () => {
    const ranked = rankCandidates(drafts, {
      best_reply: {
        type: "choice",
        choice: "reply_c",
        confidence: 0.5,
        probabilities: { reply_a: 0.2, reply_b: 0.1, reply_c: 0.7 },
      },
    })
    expect(ranked.map((c) => [c.text, c.slot, c.probability])).toEqual([
      ["简短", 2, 0.7],
      ["稳妥", 0, 0.2],
      ["行动", 1, 0.1],
    ])
  })

  it("keeps draft order, unranked, without a rank answer", () => {
    expect(rankCandidates(drafts, null).map((c) => [c.text, c.probability])).toEqual([
      ["稳妥", null],
      ["行动", null],
      ["简短", null],
    ])
  })
})
