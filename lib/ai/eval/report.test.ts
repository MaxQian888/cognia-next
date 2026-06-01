import type { EvalCaseResult, EvalSample, Score } from "@/types/eval/eval"
import { buildReport } from "./report"

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

function sc(scorerId: string, value: number, passed: boolean, error?: string): Score {
  return { scorerId, dimension: "tool-use", value, passed, ...(error ? { error } : {}) }
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

describe("buildReport", () => {
  it("carries run metadata through", () => {
    const report = build([{ caseId: "a", repetitions: [rep([sc("s1", 1, true)])] }])
    expect(report.runId).toBe("run1")
    expect(report.datasetId).toBe("d1")
    expect(report.datasetVersion).toBe(2)
    expect(report.targetLabel).toBe("opus")
    expect(report.k).toBe(1)
    expect(report.caseCount).toBe(1)
    expect(report.createdAt).toBe(123)
  })

  it("aggregates per-scorer mean value and pass rate", () => {
    const report = build([
      { caseId: "a", repetitions: [rep([sc("s1", 1, true)])] },
      { caseId: "b", repetitions: [rep([sc("s1", 0, false)])] },
    ])
    expect(report.scorers.s1.meanValue).toBe(0.5)
    expect(report.scorers.s1.passRate).toBe(0.5)
    expect(report.scorers.s1.observations).toBe(2)
    expect(report.scorers.s1.errorCount).toBe(0)
  })

  it("excludes errored scores from mean and pass rate but counts them", () => {
    const report = build([
      { caseId: "a", repetitions: [rep([sc("s1", 1, true)])] },
      { caseId: "b", repetitions: [rep([sc("s1", 0, false, "not-applicable: no ref")])] },
    ])
    expect(report.scorers.s1.meanValue).toBe(1)
    expect(report.scorers.s1.passRate).toBe(1)
    expect(report.scorers.s1.errorCount).toBe(1)
    expect(report.scorers.s1.observations).toBe(2)
  })

  it("computes passAt1 as the fraction of cases whose first rep passes all applicable scorers", () => {
    const report = build([
      { caseId: "a", repetitions: [rep([sc("s1", 1, true), sc("s2", 1, true)])] },
      { caseId: "b", repetitions: [rep([sc("s1", 1, true), sc("s2", 0, false)])] },
    ])
    expect(report.passAt1).toBe(0.5)
  })

  it("treats errored scores as not-applicable when deciding case pass", () => {
    const report = build([
      {
        caseId: "a",
        repetitions: [rep([sc("s1", 1, true), sc("s2", 0, false, "not-applicable")])],
      },
    ])
    // s2 errored → ignored; s1 passed → case passes
    expect(report.passAt1).toBe(1)
  })

  it("computes passHatK as the fraction of cases passing on every repetition", () => {
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
    expect(report.passAt1).toBe(0)
    expect(report.passHatK).toBe(0)
    expect(report.avgLatencyMs).toBe(0)
    expect(report.totalCostUsd).toBe(0)
  })
})
