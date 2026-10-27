/**
 * Eval report aggregation — and the SINGLE source of truth for "did this
 * repetition pass?".
 *
 * Folds the per-case, per-repetition {@link Score}s a run produced into an
 * {@link EvalReport}: per-scorer means + pass-rates, plus the two headline
 * reliability numbers — `passAt1` (fraction passing on the first try) and
 * `passHatK` (fraction passing on EVERY try, the honest reliability figure for
 * an agent users run repeatedly).
 *
 * Execution failure always fails a repetition. Otherwise only `scored`
 * observations decide a verdict. `not-applicable` (the case
 * carried no matching reference), `errored` (the scorer itself failed) and
 * `measurement` (unbudgeted cost, zero tool calls) are all excluded — they are
 * not agent failures, and counting the measurement ones as passes is exactly
 * what used to make a plain question/answer dataset report 100%.
 *
 * A repetition with ZERO scored observations is `ungraded`: neither a pass nor
 * a failure. Those cases leave the pass-rate denominator and are surfaced via
 * {@link EvalReport.ungradedCaseCount} instead.
 *
 * {@link repetitionVerdict} is exported because `run-config.ts` needs the same
 * decision when it writes the per-case grid rows. It used to inline its own
 * `scores.every(s => s.passed)`, which disagreed with this file on every
 * not-applicable score — the run header said 100% while the per-case table
 * below it said everything failed. Import it; never re-derive it.
 */

import type {
  EvalCaseResult,
  EvalReport,
  EvalRepetition,
  EvalSample,
  EvalExecutionStatus,
  RepetitionVerdict,
  Score,
  ScorerAggregate,
} from "./domain/eval"

/** The current scoring semantics — stamped on every report this file builds. */
export const SCORING_VERSION = 3 as const

/**
 * Earlier reports use different outcome/reliability semantics and cannot be
 * compared with current runs. They remain readable and labeled legacy.
 *
 * Lives here rather than in a component so the run list, the run detail and the
 * comparison grid all answer this the same way.
 */
export function isLegacyScoring(report: Pick<EvalReport, "scoringVersion">): boolean {
  return report.scoringVersion !== SCORING_VERSION
}

/**
 * True when the run did not finish, so its rates cover only the cases that DID
 * run. A partial run must never carry a gate verdict: "80% of the first 10 of
 * 500 cases" is not a statement about the agent.
 *
 * Rows written before `status` existed are treated as complete.
 */
export function isPartialRun(report: Pick<EvalReport, "status">): boolean {
  return report.status === "running" || report.status === "aborted" || report.status === "failed"
}

/**
 * Scorers that errored on every observation and graded nothing — a judge whose
 * provider was down, say. Their absence from the pass rate is silent, so the UI
 * raises this as an alert: the run's numbers were computed without them.
 */
export function fullyErroredScorers(report: Pick<EvalReport, "scorers">): string[] {
  return Object.values(report.scorers)
    .filter((agg) => (agg.erroredCount ?? 0) > 0 && (agg.scoredCount ?? -1) === 0)
    .map((agg) => agg.scorerId)
}

export interface BuildReportInput {
  runId: string
  datasetId: string
  datasetVersion: number
  targetLabel: string
  k: number
  results: EvalCaseResult[]
  createdAt: number
}

/** The observations that carry a verdict. Everything else is informational. */
export function gatingScores(rep: EvalRepetition): Score[] {
  return rep.scores.filter((s) => s.status === "scored")
}

/** A scorer cannot turn failed or cancelled execution into a successful run. */
export function sampleExecutionFailed(
  sample: Pick<EvalSample, "error" | "executionStatus">
): boolean {
  return (
    Boolean(sample.error) ||
    (sample.executionStatus !== undefined && sample.executionStatus !== "completed")
  )
}

/**
 * `pass` / `fail` / `ungraded` for one repetition. `ungraded` means no selected
 * scorer could grade this case at all — report it, do not invent a verdict.
 */
export function repetitionVerdict(rep: EvalRepetition): RepetitionVerdict {
  if (sampleExecutionFailed(rep.sample)) return "fail"
  const gating = gatingScores(rep)
  if (gating.length === 0) return "ungraded"
  return gating.every((s) => s.passed) ? "pass" : "fail"
}

export function buildReport(input: BuildReportInput): EvalReport {
  const { results } = input
  const caseCount = results.length

  // Per-scorer accumulation across all case×rep observations.
  const acc = new Map<
    string,
    {
      dimension: Score["dimension"]
      sum: number
      passed: number
      scored: number
      notApplicable: number
      errored: number
      measurement: number
      obs: number
    }
  >()
  let totalCostUsd = 0
  let latencySum = 0
  let sampleCount = 0
  let latencySampleCount = 0
  let costSampleCount = 0
  let estimatedCostCount = 0
  let gradedRepetitionCount = 0
  let executionFailureCount = 0
  const executionOutcomes: Record<EvalExecutionStatus, number> = {
    completed: 0,
    failed: 0,
    cancelled: 0,
    timed_out: 0,
    blocked: 0,
    interrupted: 0,
  }

  for (const result of results) {
    for (const rep of result.repetitions) {
      if (Number.isFinite(rep.sample.costUsd)) totalCostUsd += rep.sample.costUsd
      const availability = rep.sample.metricAvailability
      if (
        availability?.cost !== "unavailable" &&
        availability?.cost !== "partial" &&
        Number.isFinite(rep.sample.costUsd)
      )
        costSampleCount += 1
      if (availability?.cost === "estimated") estimatedCostCount += 1
      if (availability?.latency !== "unavailable" && Number.isFinite(rep.sample.latencyMs)) {
        latencySum += rep.sample.latencyMs
        latencySampleCount += 1
      }
      sampleCount += 1
      if (repetitionVerdict(rep) !== "ungraded") gradedRepetitionCount += 1
      const failed = sampleExecutionFailed(rep.sample)
      if (failed) executionFailureCount += 1
      const outcome =
        failed && rep.sample.executionStatus === "completed"
          ? "failed"
          : (rep.sample.executionStatus ?? (failed ? "failed" : "completed"))
      executionOutcomes[outcome] += 1
      for (const score of rep.scores) {
        const slot = acc.get(score.scorerId) ?? {
          dimension: score.dimension,
          sum: 0,
          passed: 0,
          scored: 0,
          notApplicable: 0,
          errored: 0,
          measurement: 0,
          obs: 0,
        }
        slot.obs += 1
        switch (score.status) {
          case "scored":
            slot.scored += 1
            slot.sum += score.value
            if (score.passed) slot.passed += 1
            break
          case "not-applicable":
            slot.notApplicable += 1
            break
          case "errored":
            slot.errored += 1
            break
          case "measurement":
            slot.measurement += 1
            break
        }
        acc.set(score.scorerId, slot)
      }
    }
  }

  const scorers: Record<string, ScorerAggregate> = {}
  for (const [scorerId, slot] of acc) {
    scorers[scorerId] = {
      scorerId,
      dimension: slot.dimension,
      meanValue: slot.scored > 0 ? slot.sum / slot.scored : 0,
      passRate: slot.scored > 0 ? slot.passed / slot.scored : 0,
      scoredCount: slot.scored,
      notApplicableCount: slot.notApplicable,
      erroredCount: slot.errored,
      measurementCount: slot.measurement,
      observations: slot.obs,
    }
  }

  // pass@1 uses first-attempt verdicts. pass^k uses complete, fully judged
  // case clusters; partial observations retain resources but not reliability.
  let gradedCaseCount = 0
  let passAt1Count = 0
  let passHatKCount = 0
  let incompleteCaseCount = 0
  let reliabilityCaseCount = 0
  for (const result of results) {
    const expected = result.expectedRepetitions ?? input.k
    const complete =
      expected > 0 && result.status !== "partial" && result.repetitions.length === expected
    if (!complete) incompleteCaseCount += 1
    const allJudged = result.repetitions.every((rep) => repetitionVerdict(rep) !== "ungraded")
    if (result.repetitions.some((rep) => repetitionVerdict(rep) !== "ungraded")) {
      reliabilityCaseCount += 1
      if (
        complete &&
        allJudged &&
        result.repetitions.every((rep) => repetitionVerdict(rep) === "pass")
      )
        passHatKCount += 1
    }
    const first = result.repetitions[0]
    if (!first || repetitionVerdict(first) === "ungraded") continue
    gradedCaseCount += 1
    if (repetitionVerdict(first) === "pass") passAt1Count += 1
  }

  return {
    runId: input.runId,
    datasetId: input.datasetId,
    datasetVersion: input.datasetVersion,
    targetLabel: input.targetLabel,
    k: input.k,
    caseCount,
    gradedCaseCount,
    ungradedCaseCount: caseCount - gradedCaseCount,
    attemptedRepetitionCount: sampleCount,
    gradedRepetitionCount,
    incompleteCaseCount,
    reliabilityCaseCount,
    executionFailureCount,
    executionOutcomes,
    metricAvailability: {
      cost:
        costSampleCount === sampleCount && sampleCount > 0
          ? estimatedCostCount > 0
            ? "estimated"
            : "known"
          : costSampleCount > 0
            ? "partial"
            : "unavailable",
      latency:
        latencySampleCount === sampleCount && sampleCount > 0
          ? "known"
          : latencySampleCount > 0
            ? "partial"
            : "unavailable",
    },
    scorers,
    passAt1: gradedCaseCount > 0 ? passAt1Count / gradedCaseCount : 0,
    passHatK: reliabilityCaseCount > 0 ? passHatKCount / reliabilityCaseCount : 0,
    totalCostUsd,
    avgLatencyMs: latencySampleCount > 0 ? latencySum / latencySampleCount : 0,
    createdAt: input.createdAt,
    scoringVersion: SCORING_VERSION,
    ...(incompleteCaseCount > 0 ? { status: "aborted" as const } : {}),
  }
}
