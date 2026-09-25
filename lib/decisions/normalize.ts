/**
 * Turn a provider's raw decision reply into typed answers (ADR-0194).
 *
 * Providers are plugins or remote endpoints; their payloads are untrusted and
 * drift in shape (laya adds `action`, TypeSafe adds `legend`, a gateway may
 * stringify numbers). Normalization is tolerant but never invents a verdict:
 * an answer that cannot be read for its question's type is dropped, so a
 * consumer sees "no answer" rather than a fabricated 0.
 */

import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionQuestion,
  DecisionQuestionTruncation,
  DecisionQuestions,
  DecisionRouting,
} from "@/types/decisions"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function probabilityMap(raw: unknown, keys: readonly string[]): Record<string, number> | null {
  if (!isRecord(raw)) return null
  const out: Record<string, number> = {}
  for (const key of keys) {
    const p = toNumber(raw[key])
    if (p !== null) out[key] = clamp(p, 0, 1)
  }
  return Object.keys(out).length ? out : null
}

function normalizeOne(question: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  if (!isRecord(raw)) return null
  const confidence = toNumber(raw.confidence)
  if (question.type === "noul") {
    const noul = toNumber(raw.noul)
    if (noul === null) return null
    return {
      type: "noul",
      noul: clamp(noul, 0, 1),
      ...(confidence !== null ? { confidence: clamp(confidence, 0, 1) } : {}),
    }
  }
  if (question.type === "choice") {
    const keys = Object.keys(question.criteria)
    const probabilities = probabilityMap(raw.probabilities, keys) ?? {}
    let choice = typeof raw.choice === "string" && keys.includes(raw.choice) ? raw.choice : null
    if (choice === null) {
      // A choice outside the offered keys is unreadable; fall back to the
      // argmax of the probabilities only when the provider sent them.
      const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
      choice = ranked[0]?.[0] ?? null
    }
    if (choice === null) return null
    return {
      type: "choice",
      choice,
      probabilities,
      confidence: clamp(confidence ?? probabilities[choice] ?? 0, 0, 1),
    }
  }
  const levels = question.criteria.length
  const score = toNumber(raw.score)
  if (score === null) return null
  const levelKeys = question.criteria.map((_, index) => String(index))
  const probabilities = probabilityMap(raw.probabilities, levelKeys)
  return {
    type: "score",
    score: clamp(score, 0, levels - 1),
    levels,
    confidence: clamp(confidence ?? 0, 0, 1),
    ...(probabilities ? { probabilities } : {}),
  }
}

/** Answers for the asked questions only; unreadable ones are dropped. */
export function normalizeDecisionAnswers(
  raw: unknown,
  questions: DecisionQuestions
): DecisionAnswers {
  if (!isRecord(raw)) return {}
  const answers: DecisionAnswers = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = normalizeOne(question, raw[id])
    if (answer) answers[id] = answer
  }
  return answers
}

export function normalizeDecisionRouting(raw: unknown): DecisionRouting | undefined {
  if (!isRecord(raw) || typeof raw.model !== "string" || !raw.model) return undefined
  return {
    model: raw.model,
    ...(typeof raw.reason === "string" && raw.reason ? { reason: raw.reason } : {}),
  }
}

export function normalizeDecisionTruncation(
  raw: unknown,
  questions: DecisionQuestions
): Record<string, DecisionQuestionTruncation> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, DecisionQuestionTruncation> = {}
  for (const id of Object.keys(questions)) {
    const entry = raw[id]
    if (!isRecord(entry)) continue
    const instructionTokens = toNumber(entry.instructionTokens)
    const instructionTokensKept = toNumber(entry.instructionTokensKept)
    const optionsClipped = toNumber(entry.optionsClipped)
    if (instructionTokens === null || instructionTokensKept === null || optionsClipped === null) {
      continue
    }
    out[id] = {
      instructionTokens: Math.max(0, Math.round(instructionTokens)),
      instructionTokensKept: Math.max(0, Math.round(instructionTokensKept)),
      optionsClipped: Math.max(0, Math.round(optionsClipped)),
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** Expected score level mapped to 0..1 (0 = first level, 1 = last). */
export function scoreFraction(answer: { score: number; levels: number }): number {
  return answer.levels > 1 ? clamp(answer.score / (answer.levels - 1), 0, 1) : 0
}
