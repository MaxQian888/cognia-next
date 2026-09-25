import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateDecisionQuestions } from "@/lib/decisions/validate"
import type { DecisionQuestion } from "@/types/decisions"
import {
  ACTION_KEYS,
  BACKGROUND_NOTE,
  DANGER_LEVELS,
  INTENT_KEYS,
  JUDGE_QUESTION_IDS,
  NEED_KEYS,
  chooseQuestionVariant,
  judgeQuestions,
  rankQuestion,
} from "./questions"

/** Options exactly as laya renders them (laya/common.py render_options). */
function renderedOptions(q: DecisionQuestion): string[] {
  if (q.type === "choice") return Object.entries(q.criteria).map(([k, v]) => `${k}: ${v}`)
  if (q.type === "score") return q.criteria.map((c, i) => `level ${i}: ${c}`)
  return [`false: ${q.criteria?.false ?? ""}`, `true: ${q.criteria?.true ?? ""}`]
}

describe("judgeQuestions", () => {
  it.each(["full", "compact"] as const)("%s variant is valid and complete", (variant) => {
    const questions = judgeQuestions(variant)
    expect(Object.keys(questions)).toEqual([...JUDGE_QUESTION_IDS])
    expect(validateDecisionQuestions(questions)).toBeNull()
    const intent = questions.true_intent
    const action = questions.best_action
    const need = questions.she_needs
    const danger = questions.danger_level
    expect(intent.type === "choice" && Object.keys(intent.criteria)).toEqual([...INTENT_KEYS])
    expect(action.type === "choice" && Object.keys(action.criteria)).toEqual([...ACTION_KEYS])
    expect(need.type === "choice" && Object.keys(need.criteria)).toEqual([...NEED_KEYS])
    expect(danger.type === "score" && danger.criteria.length).toBe(DANGER_LEVELS)
  })

  it("keeps the calibrated wording, background note included, in the full variant", () => {
    const full = judgeQuestions("full")
    for (const id of JUDGE_QUESTION_IDS)
      expect(full[id].instructions.endsWith(BACKGROUND_NOTE)).toBe(true)
    expect(full.true_intent.instructions).toContain("choose confirm_you_care")
  })

  it("keeps the compact variant inside a local encoder's head budget", () => {
    // ~3.5 chars per token for this English: 192 head tokens ≈ 670 chars,
    // 48 tokens per option ≈ 160 chars. Pin well inside both.
    for (const question of Object.values(judgeQuestions("compact"))) {
      const options = renderedOptions(question)
      const head = question.instructions.length + options.reduce((sum, o) => sum + o.length + 1, 0)
      expect(head).toBeLessThanOrEqual(600)
      for (const option of options) expect(option.length).toBeLessThanOrEqual(80)
    }
  })

  it("matches the export the laya calibration script scores", () => {
    // plugins/cognia-laya-guard/tools/calibrate_jev.py reads this file; a
    // wording change here must be re-exported (and re-calibrated) there.
    const file = join(__dirname, "../../plugins/cognia-laya-guard/tools/jev_compact_questions.json")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(judgeQuestions("compact"))
  })

  it("returns an independent copy each call", () => {
    const a = judgeQuestions("compact")
    a.literal_question.instructions = "mutated"
    expect(judgeQuestions("compact").literal_question.instructions).not.toBe("mutated")
  })
})

describe("chooseQuestionVariant", () => {
  it("uses compact wording only for budget-limited providers", () => {
    expect(chooseQuestionVariant({ headTokens: 192 })).toBe("compact")
    expect(chooseQuestionVariant({ headTokens: 256 })).toBe("compact")
    expect(chooseQuestionVariant({ headTokens: 1024 })).toBe("full")
    expect(chooseQuestionVariant(undefined)).toBe("full")
    expect(chooseQuestionVariant({})).toBe("full")
  })
})

describe("rankQuestion", () => {
  it("offers the three candidates as reply_a..c", () => {
    const q = rankQuestion(["好的", "我明天八点前发你", "抱歉，我查一下"], "compact")
    expect(validateDecisionQuestions(q)).toBeNull()
    expect(q.best_reply).toMatchObject({
      type: "choice",
      criteria: { reply_a: "好的", reply_b: "我明天八点前发你", reply_c: "抱歉，我查一下" },
    })
    expect(rankQuestion(["a", "b", "c"], "full").best_reply.instructions).toContain(BACKGROUND_NOTE)
  })

  it("ranks two candidates and refuses fewer or more than the keys allow", () => {
    expect(rankQuestion(["a", "b"], "compact").best_reply).toMatchObject({
      criteria: { reply_a: "a", reply_b: "b" },
    })
    expect(() => rankQuestion(["a"], "compact")).toThrow(/2-3/)
    expect(() => rankQuestion(["a", "b", "c", "d"], "compact")).toThrow(/2-3/)
  })
})
