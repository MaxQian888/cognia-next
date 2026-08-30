/**
 * CI gate evaluation — turns an {@link EvalReport} into a pass/fail decision
 * against configured thresholds. Pure; the `test:evals` regression test and the
 * in-app dashboard both use it.
 *
 * "Pass rate is a product decision" — thresholds are explicit, not baked in.
 */

import type { EvalReport, ScorerAggregate } from "./domain/eval"
import type { GateThresholds, GateResult, GateVerdict } from "./domain/gate"

export type { GateThresholds, GateResult, GateVerdict } from "./domain/gate"

/**
 * True when this scorer actually produced verdicts. A scorer that graded
 * nothing reports `passRate: 0`, which is an absence of signal — NOT a 0%
 * pass. Gating on it would fail every run that simply doesn't use that scorer
 * (e.g. the unbudgeted `cost` scorer, which only ever measures).
 *
 * Legacy reports carry no `scoredCount`; fall back to `observations` so their
 * verdicts stay exactly what they were.
 */
function graded(agg: ScorerAggregate): boolean {
  return (agg.scoredCount ?? agg.observations) > 0
}

export function evaluateGate(report: EvalReport, thresholds: GateThresholds): GateResult {
  const failures: string[] = []
  const inconclusiveReasons: string[] = []

  // A run that graded nothing reports `passAt1: 0`, which every floor below
  // would read as total failure. No evidence is not a failing grade — say so
  // and skip the rate checks rather than inventing a verdict from a zero that
  // means "unknown". Legacy reports carry no count; leave those alone.
  const wantsRates = thresholds.minPassHatK !== undefined || thresholds.minPassAt1 !== undefined
  const noGradedCases = report.gradedCaseCount === 0
  if (wantsRates && noGradedCases) {
    inconclusiveReasons.push(
      `no case produced a verdict (${report.caseCount} case(s), all ungraded)`
    )
  }

  if (!noGradedCases) {
    if (thresholds.minPassHatK !== undefined && report.passHatK < thresholds.minPassHatK) {
      failures.push(`passHatK ${report.passHatK.toFixed(3)} < ${thresholds.minPassHatK}`)
    }
    if (thresholds.minPassAt1 !== undefined && report.passAt1 < thresholds.minPassAt1) {
      failures.push(`passAt1 ${report.passAt1.toFixed(3)} < ${thresholds.minPassAt1}`)
    }
  }

  for (const scorerId of thresholds.requiredScorerIds ?? []) {
    const aggregate = report.scorers[scorerId]
    if (!aggregate) {
      inconclusiveReasons.push(`required scorer ${scorerId} produced no observations`)
    } else if (!graded(aggregate)) {
      inconclusiveReasons.push(`required scorer ${scorerId} graded nothing`)
    }
  }

  if (thresholds.minScorerPassRate !== undefined) {
    const spec = thresholds.minScorerPassRate
    if (typeof spec === "number") {
      for (const [scorerId, agg] of Object.entries(report.scorers)) {
        if (!graded(agg)) continue
        if (agg.passRate < spec) {
          failures.push(`scorer ${scorerId} passRate ${agg.passRate.toFixed(3)} < ${spec}`)
        }
      }
    } else {
      for (const [scorerId, floor] of Object.entries(spec)) {
        const agg = report.scorers[scorerId]
        if (!agg || !graded(agg)) continue
        if (agg.passRate < floor) {
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

  // Guards against a high pass rate measured over almost nothing. Legacy
  // reports have no ungraded counts, so the check is skipped for them rather
  // than treated as "0% ungraded" — which would silently pass.
  if (thresholds.maxUngradedRatio !== undefined && report.caseCount > 0) {
    const ungraded = report.ungradedCaseCount
    if (ungraded !== undefined) {
      const ratio = ungraded / report.caseCount
      if (ratio > thresholds.maxUngradedRatio) {
        failures.push(`ungraded ${ratio.toFixed(3)} > ${thresholds.maxUngradedRatio}`)
      }
    }
  }

  // A real failure outranks missing evidence: if something actually breached a
  // floor, the run failed — the fact that a different scorer went unmeasured
  // does not soften that.
  const verdict: GateVerdict = failures.length
    ? "fail"
    : inconclusiveReasons.length
      ? "inconclusive"
      : "pass"
  return { passed: verdict === "pass", verdict, failures, inconclusiveReasons }
}
