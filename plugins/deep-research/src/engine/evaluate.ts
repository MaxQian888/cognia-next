/**
 * Independent answer evaluation. Separated from generation because LLM
 * self-evaluation is unreliable; a dedicated criteria-driven pass is more
 * consistent. Fails OPEN (treats an unparseable verdict as a pass) so a flaky
 * evaluator can't wedge the loop — the budget/bad-attempt caps still bound it.
 */
import type { AiBridge } from "../lib/ai"
import { completeJson } from "../lib/ai"
import { extractJson } from "../lib/json"
import { evaluateMessages } from "./prompts"

export interface Evaluation {
  pass: boolean
  reasons: string[]
}

interface RawEvaluation {
  pass?: unknown
  reasons?: unknown
}

export async function evaluateAnswer(
  question: string,
  answer: string,
  evidence: string,
  ai: AiBridge,
  locale?: string
): Promise<{ evaluation: Evaluation; tokens: number }> {
  try {
    const res = await completeJson<RawEvaluation>(
      ai,
      evaluateMessages(question, answer, evidence, locale),
      (t) => extractJson<RawEvaluation>(t),
      { temperature: 0, maxTokens: 400 }
    )
    return { evaluation: normalizeEvaluation(res.value), tokens: res.tokens }
  } catch {
    return {
      evaluation: { pass: true, reasons: ["evaluator unavailable — accepted by default"] },
      tokens: 0,
    }
  }
}

export function normalizeEvaluation(raw: RawEvaluation): Evaluation {
  const pass = raw.pass === true
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((r): r is string => typeof r === "string")
    : []
  return { pass, reasons }
}
