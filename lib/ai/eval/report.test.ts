import type {
  EvalCaseResult,
  EvalSample,
  Score,
  ScorerAggregate,
  ScoreStatus,
} from "@/types/eval/eval"
import {
  buildReport,
  fullyErroredScorers,
  gatingScores,
  isLegacyScoring,
  repetitionVerdict,
  SCORING_VERSION,
} from "./report"

function sample(overrides: Partial<EvalSample> = {}): EvalSample {
  return {
    output: "ok",
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0.01,
    latencyMs: 100,
    stepCount: 1,
    degraded: false,
    ...overrides,
  }
}

/** A real verdict. */
function sc(scorerId: string, value: number, passed: boolean): Score {
  return { scorerId, dimension: "tool-use", status: "scored", value, passed }
}

/** A non-verdict observation of the given status. */
function nonScored(scorerId: string, status: Exclude<ScoreStatus, "scored">): Score {
  return { scorerId, dimension: "tool-use", status, value: 0, passed: false, error: status }
}

function rep(scores: Score[], s: EvalSample = sample()) {
  return { sample: s, scores }
}

function build(results: EvalCaseResult[], k = 1) {
  return buildReport({
    runId: "run1",
    datasetId: "d1",
    datasetVersion: 2,
    targetLabel: "opus",
    k,
    results,
    createdAt: 123,
  })
}

describe("repetitionVerdict", () => {
  it("passes only when every scored observation passed", () => {
    expect(repetitionVerdict(rep([sc("s1", 1, true), sc("s2", 1, true)]))).toBe("pass")
    expect(repetitionVerdict(rep([sc("s1", 1, true), sc("s2", 0, false)]))).toBe("fail")
  })

  it("ignores not-applicable, errored and measurement observations", () => {
    const verdict = repetitionVerdict(
      rep([
        sc("s1", 1, true),
        nonScored("s2", "not-applicable"),
        nonScored("s3", "errored"),
        nonScored("s4", "measurement"),
      ])
    )
    expect(verdict).toBe("pass")
  })

  it("reports ungraded when nothing produced a verdict", () => {
    // The regression this whole change exists for: a plain question/answer case
    // where every reference-based scorer is not-applicable and the two
    // reference-free ones only measure. This must NOT read as a pass.
    const verdict = repetitionVerdict(
      rep([
        nonScored("assertion", "not-applicable"),
        nonScored("tool-selection", "not-applicable"),
        nonScored("tool-redundancy", "measurement"),
        nonScored("cost", "measurement"),
      ])
    )
    expect(verdict).toBe("ungraded")
  })

  it("reports ungraded when the scorer died on every criterion", () => {
    expect(repetitionVerdict(rep([nonScored("judge", "errored")]))).toBe("ungraded")
  })

  it("exposes the gating subset", () => {
    const scores = [sc("s1", 1, true), nonScored("s2", "measurement")]
    expect(gatingScores(rep(scores)).map((s) => s.scorerId)).toEqual(["s1"])
  })
})

describe("isLegacyScoring", () => {
  it("treats a missing scoringVersion as legacy", () => {
    expect(isLegacyScoring({ scoringVersion: undefined })).toBe(true)
    expect(isLegacyScoring({ scoringVersion: 2 })).toBe(false)
  })

  it("never flags a freshly built report", () => {
    expect(isLegacyScoring(build([{ caseId: "a", repetitions: [rep([sc("s1", 1, true)])] }]))).toBe(
      false
    )
  })
})

describe("fullyErroredScorers", () => {
  function agg(scorerId: string, over: Partial<ScorerAggregate> = {}): ScorerAggregate {
    return {
      scorerId,
      dimension: "response-quality",
      meanValue: 0,
      passRate: 0,
      scoredCount: 0,
      notApplicableCount: 0,
      erroredCount: 0,
      measurementCount: 0,
      observations: 2,
      ...over,
    }
  }

  it("flags only scorers that errored and graded nothing", () => {
    const scorers = {
      judge: agg("judge", { erroredCount: 2 }),
      flaky: agg("flaky", { erroredCount: 1, scoredCount: 1 }),
      clean: agg("clean", { scoredCount: 2 }),
      na: agg("na", { notApplicableCount: 2 }),
    }
    // `flaky` still produced a verdict; `na` never errored — neither is an alarm.
    expect(fullyErroredScorers({ scorers })).toEqual(["judge"])
  })

  it("stays quiet on a legacy report with no per-status counts", () => {
    const legacy = agg("judge")
    delete (legacy as Partial<ScorerAggregate>).scoredCount
    delete (legacy as Partial<ScorerAggregate>).erroredCount
    expect(fullyErroredScorers({ scorers: { judge: legacy } })).toEqual([])
  })
})

describe("buildReport", () => {
  it("carries run metadata through and stamps the scoring version", () => {
    const report = build([{ caseId: "a", repetitions: [rep([sc("s1", 1, true)])] }])
    expect(report.runId).toBe("run1")
    expect(report.datasetId).toBe("d1")
    expect(report.datasetVersion).toBe(2)
    expect(report.targetLabel).toBe("opus")
    expect(report.k).toBe(1)
    expect(report.caseCount).toBe(1)
    expect(report.createdAt).toBe(123)
    expect(report.scoringVersion).toBe(SCORING_VERSION)
  })

  it("aggregates per-scorer mean value and pass rate", () => {
    const report = build([
      { caseId: "a", repetitions: [rep([sc("s1", 1, true)])] },
      { caseId: "b", repetitions: [rep([sc("s1", 0, false)])] },
    ])
    expect(report.scorers.s1.meanValue).toBe(0.5)
    expect(report.scorers.s1.passRate).toBe(0.5)
    expect(report.scorers.s1.observations).toBe(2)
    expect(report.scorers.s1.notApplicableCount).toBe(0)
    expect(report.scorers.s1.erroredCount).toBe(0)
    expect(report.scorers.s1.measurementCount).toBe(0)
  })

  it("counts each non-verdict status separately instead of lumping them together", () => {
    const report = build([
      { caseId: "a", repetitions: [rep([sc("s1", 1, true)])] },
      { caseId: "b", repetitions: [rep([nonScored("s1", "not-applicable")])] },
      { caseId: "c", repetitions: [rep([nonScored("s1", "errored")])] },
      { caseId: "d", repetitions: [rep([nonScored("s1", "measurement")])] },
    ])
    // Means and pass-rates see only the one scored observation.
    expect(report.scorers.s1.meanValue).toBe(1)
    expect(report.scorers.s1.passRate).toBe(1)
    expect(report.scorers.s1.observations).toBe(4)
    expect(report.scorers.s1.notApplicableCount).toBe(1)
    expect(report.scorers.s1.erroredCount).toBe(1)
    expect(report.scorers.s1.measurementCount).toBe(1)
  })

  it("computes passAt1 over graded cases only", () => {
    const report = build([
      { caseId: "a", repetitions: [rep([sc("s1", 1, true), sc("s2", 1, true)])] },
      { caseId: "b", repetitions: [rep([sc("s1", 1, true), sc("s2", 0, false)])] },
    ])
    expect(report.passAt1).toBe(0.5)
    expect(report.gradedCaseCount).toBe(2)
    expect(report.ungradedCaseCount).toBe(0)
  })

  it("ignores non-verdict scores when deciding a case pass", () => {
    const report = build([
      {
        caseId: "a",
        repetitions: [rep([sc("s1", 1, true), nonScored("s2", "not-applicable")])],
      },
    ])
    expect(report.passAt1).toBe(1)
  })

  it("drops ungraded cases from the pass-rate denominator and reports them", () => {
    // 3 cases: one passes, one fails, one nothing could grade.
    const report = build([
      { caseId: "a", repetitions: [rep([sc("s1", 1, true)])] },
      { caseId: "b", repetitions: [rep([sc("s1", 0, false)])] },
      { caseId: "c", repetitions: [rep([nonScored("s1", "not-applicable")])] },
    ])
    expect(report.caseCount).toBe(3)
    expect(report.gradedCaseCount).toBe(2)
    expect(report.ungradedCaseCount).toBe(1)
    expect(report.passAt1).toBe(0.5) // 1 of 2 graded — NOT 1/3 and NOT 2/3
  })

  it("reports 0 pass rate rather than NaN when every case is ungraded", () => {
    const report = build([
      { caseId: "a", repetitions: [rep([nonScored("cost", "measurement")])] },
      { caseId: "b", repetitions: [rep([nonScored("cost", "measurement")])] },
    ])
    expect(report.gradedCaseCount).toBe(0)
    expect(report.ungradedCaseCount).toBe(2)
    expect(report.passAt1).toBe(0)
    expect(report.passHatK).toBe(0)
  })

  it("computes passHatK as the fraction of graded cases passing on every repetition", () => {
    const report = build(
      [
        { caseId: "a", repetitions: [rep([sc("s1", 1, true)]), rep([sc("s1", 1, true)])] },
        { caseId: "b", repetitions: [rep([sc("s1", 1, true)]), rep([sc("s1", 0, false)])] },
      ],
      2
    )
    expect(report.passAt1).toBe(1) // both pass on rep 0
    expect(report.passHatK).toBe(0.5) // only "a" passes both reps
  })

  it("sums cost and averages latency across all case×rep samples", () => {
    const report = build([
      {
        caseId: "a",
        repetitions: [rep([sc("s1", 1, true)], sample({ costUsd: 0.02, latencyMs: 200 }))],
      },
      {
        caseId: "b",
        repetitions: [rep([sc("s1", 1, true)], sample({ costUsd: 0.04, latencyMs: 400 }))],
      },
    ])
    expect(report.totalCostUsd).toBeCloseTo(0.06, 6)
    expect(report.avgLatencyMs).toBe(300)
  })

  it("handles an empty result set without dividing by zero", () => {
    const report = build([])
    expect(report.caseCount).toBe(0)
    expect(report.gradedCaseCount).toBe(0)
    expect(report.ungradedCaseCount).toBe(0)
    expect(report.passAt1).toBe(0)
    expect(report.passHatK).toBe(0)
    expect(report.avgLatencyMs).toBe(0)
    expect(report.totalCostUsd).toBe(0)
  })
})
