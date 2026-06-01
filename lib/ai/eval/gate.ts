/**
 * CI gate evaluation — turns an {@link EvalReport} into a pass/fail decision
 * against configured thresholds. Pure; the `test:evals` regression test and the
 * in-app dashboard both use it.
 *
 * "Pass rate is a product decision" — thresholds are explicit, not baked in.
 */

import type { EvalReport } from "@/types/eval/eval"

export interface GateThresholds {
  /** Minimum acceptable pass^k reliability. */
  minPassHatK?: number
  /** Minimum acceptable pass@1. */
  minPassAt1?: number
  /**
   * Per-scorer pass-rate floor: a single number applied to every scorer, or a
   * map of scorerId → floor (scorers absent from the report are ignored).
   */
  minScorerPassRate?: number | Record<string, number>
  /** Maximum acceptable total cost. */
  maxTotalCostUsd?: number
}

export interface GateResult {
  passed: boolean
  failures: string[]
}

export function evaluateGate(report: EvalReport, thresholds: GateThresholds): GateResult {
  const failures: string[] = []

  if (thresholds.minPassHatK !== undefined && report.passHatK < thresholds.minPassHatK) {
    failures.push(`passHatK ${report.passHatK.toFixed(3)} < ${thresholds.minPassHatK}`)
  }
  if (thresholds.minPassAt1 !== undefined && report.passAt1 < thresholds.minPassAt1) {
    failures.push(`passAt1 ${report.passAt1.toFixed(3)} < ${thresholds.minPassAt1}`)
  }

  if (thresholds.minScorerPassRate !== undefined) {
    const spec = thresholds.minScorerPassRate
    if (typeof spec === "number") {
      for (const [scorerId, agg] of Object.entries(report.scorers)) {
        if (agg.passRate < spec) {
          failures.push(`scorer ${scorerId} passRate ${agg.passRate.toFixed(3)} < ${spec}`)
        }
      }
    } else {
      for (const [scorerId, floor] of Object.entries(spec)) {
        const agg = report.scorers[scorerId]
        if (agg && agg.passRate < floor) {
          failures.push(`scorer ${scorerId} passRate ${agg.passRate.toFixed(3)} < ${floor}`)
        }
      }
    }
  }

  if (
    thresholds.maxTotalCostUsd !== undefined &&
    report.totalCostUsd > thresholds.maxTotalCostUsd
  ) {
    failures.push(`cost ${report.totalCostUsd.toFixed(4)} > ${thresholds.maxTotalCostUsd}`)
  }

  return { passed: failures.length === 0, failures }
}
