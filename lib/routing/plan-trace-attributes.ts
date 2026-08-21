/**
 * The `routing.plan` trace payload, built in one place.
 *
 * Two call sites emit this event — the chat/agent executor and the teammate
 * dispatcher — and they had drifted to two hand-written attribute objects. A
 * calibration pipeline that reads one shape and is fed another silently
 * analyses half its data, so the shape lives here and both sites project
 * through it.
 *
 * **Numbers and enums only.** `analyzeRoutingCalibration` reads decisions and
 * never content; a trace attribute carrying prompt text would break that at the
 * source, on a path that runs for every routed turn. Everything below is either
 * an id, an enum, a count, or a bounded score.
 */

import type { RoutingPlan } from "@cognia/provider-types/auto-router"

export interface RoutingPlanTraceAttributes extends Record<string, unknown> {
  decisionId: string
  surface: string
  strategy: string
  providerId: string
  modelId: string
  candidateCount: number
  reasonCodes: string[]
  category?: string
  complexity?: string
  difficultyScore?: number
  /** Tier the deterministic score chose, before any judge was consulted. */
  deterministicTier?: string
  /** Tier actually used. Differs from `deterministicTier` only on an override. */
  difficultyTier?: string
  judgeUsed?: boolean
  judgeTier?: string
  judgeConfidence?: number
  judgeLatencyMs?: number
  /** Per-signal contributions, each already bounded to [0, 1]. */
  signals?: Record<string, number>
}

export function routingPlanTraceAttributes(plan: RoutingPlan): RoutingPlanTraceAttributes {
  const difficulty = plan.difficulty
  return {
    decisionId: plan.decisionId,
    surface: plan.surface,
    strategy: String(plan.strategy),
    providerId: plan.selected.providerId,
    modelId: plan.selected.modelId,
    candidateCount: plan.orderedCandidates.length,
    reasonCodes: [...plan.reasonCodes],
    ...(plan.classification
      ? {
          category: plan.classification.category,
          complexity: plan.classification.complexity,
          difficultyScore: plan.classification.difficultyScore,
        }
      : {}),
    ...(difficulty
      ? {
          // Kept beside each other on purpose: when a judge moved the decision,
          // the pair IS the record of the disagreement, and calibration needs
          // both to say whether asking was worth it.
          deterministicTier: difficulty.deterministicTier,
          difficultyTier: difficulty.tier,
          judgeUsed: difficulty.judgeUsed,
          ...(difficulty.judgeTier ? { judgeTier: difficulty.judgeTier } : {}),
          ...(difficulty.judgeConfidence !== undefined
            ? { judgeConfidence: difficulty.judgeConfidence }
            : {}),
          ...(difficulty.judgeLatencyMs !== undefined
            ? { judgeLatencyMs: difficulty.judgeLatencyMs }
            : {}),
          signals: { ...difficulty.signals },
          // The plan's own score wins over the classification's when a judge
          // moved it — otherwise calibration would tune thresholds against a
          // number the router did not actually route on.
          difficultyScore: difficulty.score,
        }
      : {}),
  }
}
