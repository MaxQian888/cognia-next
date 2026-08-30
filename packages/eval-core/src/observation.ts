/**
 * One evaluation observation, whatever produced it.
 *
 * Offline runs, online policies, and human review all answer the same
 * question — "how did this do?" — and the temptation is to give each its own
 * score model. Three score models means three definitions of "passing" and a
 * quality number nobody can reconcile. So there is one envelope, and it wraps
 * the existing {@link Score} rather than replacing it: `origin` is the only new
 * semantic axis.
 */

import type { Score } from "./domain/eval"

/**
 * Where the verdict came from.
 *
 *  - `offline` — a deliberate run against a dataset.
 *  - `online`  — a policy scored a production trace.
 *  - `human`   — a reviewer decided, directly or via adjudication.
 */
export type ObservationOrigin = "offline" | "online" | "human"

/** What the observation is about. Every field optional; origin decides which apply. */
export interface ObservationScope {
  runId?: string
  experimentId?: string
  variantId?: string
  caseId?: string
  /** 1-based repetition index within a case. */
  repetition?: number
  /** Set for `online` observations — the production trace that was scored. */
  traceId?: string
}

export interface EvalObservationV1 {
  schema: "cognia-observation/v1"
  id: string
  scope: ObservationScope
  origin: ObservationOrigin
  /** The exact evaluator VERSION that produced this — never a bare id. */
  evaluatorVersionId: string
  score: Score
  /** Digest of the evidence scored, so a stored verdict can be tied to its input. */
  evidenceDigest?: string
  createdAt: number
}

export const OBSERVATION_SCHEMA = "cognia-observation/v1" as const

export interface BuildObservationInput {
  id: string
  scope: ObservationScope
  origin: ObservationOrigin
  evaluatorVersionId: string
  score: Score
  evidenceDigest?: string
  createdAt: number
}

export function buildObservation(input: BuildObservationInput): EvalObservationV1 {
  return {
    schema: OBSERVATION_SCHEMA,
    id: input.id,
    scope: input.scope,
    origin: input.origin,
    evaluatorVersionId: input.evaluatorVersionId,
    score: input.score,
    ...(input.evidenceDigest !== undefined ? { evidenceDigest: input.evidenceDigest } : {}),
    createdAt: input.createdAt,
  }
}

/**
 * The observations that decide anything. Mirrors `report.ts:gatingScores` —
 * only `scored` carries a verdict, and reading `errored` or `not-applicable`
 * as a failure is the exact bug `ScoreStatus` was introduced to kill.
 */
export function isDecidingObservation(observation: EvalObservationV1): boolean {
  return observation.score.status === "scored"
}

/**
 * Rows written before this envelope existed carry no scope and no origin.
 * They were all produced by deliberate runs, so they read as `offline` — and
 * they are NOT rewritten: a migration that invents provenance is worse than an
 * absent field, because the invention is indistinguishable from a real record.
 */
export function legacyObservationOrigin(): ObservationOrigin {
  return "offline"
}

export interface ObservationSummary {
  total: number
  deciding: number
  passed: number
  byStatus: Record<Score["status"], number>
  byOrigin: Record<ObservationOrigin, number>
}

export function summarizeObservations(
  observations: readonly EvalObservationV1[]
): ObservationSummary {
  const summary: ObservationSummary = {
    total: observations.length,
    deciding: 0,
    passed: 0,
    byStatus: { scored: 0, "not-applicable": 0, errored: 0, measurement: 0 },
    byOrigin: { offline: 0, online: 0, human: 0 },
  }
  for (const observation of observations) {
    summary.byStatus[observation.score.status] += 1
    summary.byOrigin[observation.origin] += 1
    if (isDecidingObservation(observation)) {
      summary.deciding += 1
      if (observation.score.passed) summary.passed += 1
    }
  }
  return summary
}
