/**
 * Eval report aggregation.
 *
 * Folds the per-case, per-repetition {@link Score}s a run produced into an
 * {@link EvalReport}: per-scorer means + pass-rates, plus the two headline
 * reliability numbers — `passAt1` (fraction passing on the first try) and
 * `passHatK` (fraction passing on EVERY try, the honest reliability figure for
 * an agent users run repeatedly).
 *
 * Errored scores (a scorer that threw, or returned a "not-applicable" sentinel
 * because the case carried no matching reference) are excluded from means and
 * pass-rates and from the case-pass decision — they are not-applicable, not
 * failures.
 */

import type {
  EvalCaseResult,
  EvalReport,
  EvalRepetition,
  Score,
  ScorerAggregate,
} from "@/types/eval/eval"

export interface BuildReportInput {
  runId: string
  datasetId: string
  datasetVersion: number
  targetLabel: string
  k: number
  results: EvalCaseResult[]
  createdAt: number
}

const isApplicable = (s: Score): boolean => !s.error

/** A repetition passes when it has ≥1 applicable score and all of them passed. */
function repetitionPassed(rep: EvalRepetition): boolean {
  const applicable = rep.scores.filter(isApplicable)
  return applicable.length > 0 && applicable.every((s) => s.passed)
}

export function buildReport(input: BuildReportInput): EvalReport {
  const { results } = input
  const caseCount = results.length

  // Per-scorer accumulation across all case×rep observations.
  const acc = new Map<
    string,
    { dimension: Score["dimension"]; sum: number; passed: number; errors: number; obs: number }
  >()
  let totalCostUsd = 0
  let latencySum = 0
  let sampleCount = 0

  for (const result of results) {
    for (const rep of result.repetitions) {
      totalCostUsd += rep.sample.costUsd
      latencySum += rep.sample.latencyMs
      sampleCount += 1
      for (const score of rep.scores) {
        const slot = acc.get(score.scorerId) ?? {
          dimension: score.dimension,
          sum: 0,
          passed: 0,
          errors: 0,
          obs: 0,
        }
        slot.obs += 1
        if (isApplicable(score)) {
          slot.sum += score.value
          if (score.passed) slot.passed += 1
        } else {
          slot.errors += 1
        }
        acc.set(score.scorerId, slot)
      }
    }
  }

  const scorers: Record<string, ScorerAggregate> = {}
  for (const [scorerId, slot] of acc) {
    const applicableObs = slot.obs - slot.errors
    scorers[scorerId] = {
      scorerId,
      dimension: slot.dimension,
      meanValue: applicableObs > 0 ? slot.sum / applicableObs : 0,
      passRate: applicableObs > 0 ? slot.passed / applicableObs : 0,
      errorCount: slot.errors,
      observations: slot.obs,
    }
  }

  let passAt1Count = 0
  let passHatKCount = 0
  for (const result of results) {
    if (result.repetitions.length > 0 && repetitionPassed(result.repetitions[0])) {
      passAt1Count += 1
    }
    if (result.repetitions.length > 0 && result.repetitions.every((rep) => repetitionPassed(rep))) {
      passHatKCount += 1
    }
  }

  return {
    runId: input.runId,
    datasetId: input.datasetId,
    datasetVersion: input.datasetVersion,
    targetLabel: input.targetLabel,
    k: input.k,
    caseCount,
    scorers,
    passAt1: caseCount > 0 ? passAt1Count / caseCount : 0,
    passHatK: caseCount > 0 ? passHatKCount / caseCount : 0,
    totalCostUsd,
    avgLatencyMs: sampleCount > 0 ? latencySum / sampleCount : 0,
    createdAt: input.createdAt,
  }
}
