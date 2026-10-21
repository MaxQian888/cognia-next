/**
 * Did changing the rule make the agent better? (ADR-0238 §11)
 *
 * Two kinds of evidence, both comparisons and neither a model's opinion:
 *
 * - adherence before and after: the same checks replayed over sessions
 *   created before an applied change and over sessions created since;
 * - eval A/B: one eval dataset run against the workspace before the change
 *   (baseline) and after it (candidate), with everything else the same.
 *
 * Small samples say little, so each comparison reports whether it has enough
 * data to mean anything instead of a bare delta.
 */

import { followRate, MIN_OPPORTUNITIES, type CheckResult } from "../adherence/backtest"
import type { EvalRecord } from "../runtime/store"

export type Direction = "better" | "worse" | "same" | "insufficient"

export interface CheckComparison {
  checkId: string
  before?: number
  after?: number
  beforeOpportunities: number
  afterOpportunities: number
  direction: Direction
}

/** A change smaller than this in follow rate is noise. */
export const RATE_EPSILON = 0.1
/** A pass@1 change smaller than this is noise. */
export const PASS_EPSILON = 0.05

export function compareAdherence(
  before: readonly CheckResult[],
  after: readonly CheckResult[]
): CheckComparison[] {
  const afterById = new Map(after.map((result) => [result.checkId, result]))
  return before.map((left) => {
    const right = afterById.get(left.checkId)
    const beforeRate = followRate(left)
    const afterRate = right ? followRate(right) : undefined
    const beforeOpportunities = left.opportunities
    const afterOpportunities = right?.opportunities ?? 0
    let direction: Direction = "insufficient"
    if (
      beforeRate !== undefined &&
      afterRate !== undefined &&
      beforeOpportunities >= MIN_OPPORTUNITIES &&
      afterOpportunities >= MIN_OPPORTUNITIES
    ) {
      const delta = afterRate - beforeRate
      direction = Math.abs(delta) < RATE_EPSILON ? "same" : delta > 0 ? "better" : "worse"
    }
    return {
      checkId: left.checkId,
      ...(beforeRate !== undefined ? { before: beforeRate } : {}),
      ...(afterRate !== undefined ? { after: afterRate } : {}),
      beforeOpportunities,
      afterOpportunities,
      direction,
    }
  })
}

export interface EvalComparison {
  baseline: EvalRecord
  candidate: EvalRecord
  delta?: number
  direction: Direction
}

/** Pair each candidate with the latest earlier baseline of the same dataset, model and workspace. */
export function compareEvals(records: readonly EvalRecord[]): EvalComparison[] {
  const sorted = [...records].sort((a, b) => a.at - b.at)
  const out: EvalComparison[] = []
  for (const candidate of sorted) {
    if (candidate.role !== "candidate") continue
    const baseline = [...sorted]
      .reverse()
      .find(
        (record) =>
          record.role === "baseline" &&
          record.at < candidate.at &&
          record.datasetId === candidate.datasetId &&
          record.model === candidate.model &&
          record.workspaceId === candidate.workspaceId
      )
    if (!baseline) continue
    if (baseline.passAt1 === undefined || candidate.passAt1 === undefined) {
      out.push({ baseline, candidate, direction: "insufficient" })
      continue
    }
    const delta = candidate.passAt1 - baseline.passAt1
    out.push({
      baseline,
      candidate,
      delta,
      direction: Math.abs(delta) < PASS_EPSILON ? "same" : delta > 0 ? "better" : "worse",
    })
  }
  return out.reverse()
}

/** The fields of an eval run result this plugin reads, from `ctx.eval.runDataset`. */
export function readEvalOutcome(value: unknown): {
  runIds: string[]
  passAt1?: number
  totalCostUsd?: number
} {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const runIds = Array.isArray(row.runIds)
    ? row.runIds.filter((id): id is string => typeof id === "string")
    : []
  return {
    runIds,
    ...(typeof row.passAt1 === "number" ? { passAt1: row.passAt1 } : {}),
    ...(typeof row.totalCostUsd === "number" ? { totalCostUsd: row.totalCostUsd } : {}),
  }
}
