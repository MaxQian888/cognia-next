/**
 * Typed view of the copilot's decision answers (ADR-0194). Wire ids stay as
 * the calibrated question set names them (`she_needs`); this module is where
 * they become neutral domain fields the UI reads.
 */

import type { ChoiceAnswer, DecisionAnswer, DecisionAnswers } from "@/types/decisions"
import {
  ACTION_KEYS,
  DANGER_LEVELS,
  INTENT_KEYS,
  NEED_KEYS,
  RANK_KEYS,
  type ActionKey,
  type IntentKey,
  type NeedKey,
} from "@/lib/reply-copilot/questions"

export interface ChoiceVerdict<K extends string> {
  key: K
  confidence: number
  probabilities: Partial<Record<K, number>>
}

export interface CopilotJudgment {
  /** P(the latest message means exactly what it says). */
  literal: number | null
  intent: ChoiceVerdict<IntentKey> | null
  /** Expected danger level, 0 (light chat) … 9 (active rupture). */
  danger: { level: number; levels: number; confidence: number } | null
  /** P(the next message should carry substance — a fact, fault, time or plan). */
  substanceNow: number | null
  bestAction: ChoiceVerdict<ActionKey> | null
  need: ChoiceVerdict<NeedKey> | null
  /** P(the tension is already resolved). */
  tensionResolved: number | null
}

export type DangerTone = "calm" | "watch" | "tense" | "critical"

function noul(answer: DecisionAnswer | undefined): number | null {
  return answer?.type === "noul" ? answer.noul : null
}

function choice<K extends string>(
  answer: DecisionAnswer | undefined,
  keys: readonly K[]
): ChoiceVerdict<K> | null {
  if (answer?.type !== "choice") return null
  const { choice: key, confidence, probabilities } = answer as ChoiceAnswer
  if (!(keys as readonly string[]).includes(key)) return null
  const filtered: Partial<Record<K, number>> = {}
  for (const k of keys) {
    if (typeof probabilities[k] === "number") filtered[k] = probabilities[k]
  }
  return { key: key as K, confidence, probabilities: filtered }
}

export function toJudgment(answers: DecisionAnswers): CopilotJudgment {
  const danger = answers.danger_level
  return {
    literal: noul(answers.literal_question),
    intent: choice(answers.true_intent, INTENT_KEYS),
    danger:
      danger?.type === "score"
        ? {
            level: Math.min(DANGER_LEVELS - 1, Math.max(0, danger.score)),
            levels: danger.levels,
            confidence: danger.confidence,
          }
        : null,
    substanceNow: noul(answers.should_reply_now),
    bestAction: choice(answers.best_action, ACTION_KEYS),
    need: choice(answers.she_needs, NEED_KEYS),
    tensionResolved: noul(answers.tension_resolved),
  }
}

/** True when the provider answered none of the judge questions readably. */
export function isEmptyJudgment(judgment: CopilotJudgment): boolean {
  return Object.values(judgment).every((value) => value === null)
}

/** Colour band for the 0–9 danger level. */
export function dangerTone(level: number): DangerTone {
  if (level < 2.5) return "calm"
  if (level < 4.5) return "watch"
  if (level < 6.5) return "tense"
  return "critical"
}

export interface RankedCandidate {
  text: string
  /** P(best) from the rank question; null when ranking was unavailable. */
  probability: number | null
  /** Draft position (0–2) — the strategy slot it was written for. */
  slot: number
}

/** Candidates sorted by the `best_reply` answer; draft order when unranked. */
export function rankCandidates(
  candidates: readonly string[],
  answers: DecisionAnswers | null
): RankedCandidate[] {
  const best = answers?.best_reply
  const probabilities = best?.type === "choice" ? best.probabilities : null
  const ranked = candidates.map((text, slot) => ({
    text,
    slot,
    probability: probabilities ? (probabilities[RANK_KEYS[slot]] ?? 0) : null,
  }))
  if (!probabilities) return ranked
  return ranked.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0) || a.slot - b.slot)
}
