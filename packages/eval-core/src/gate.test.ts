import type { EvalReport, ScorerAggregate } from "./domain/eval"
import { evaluateGate } from "./gate"

function agg(scorerId: string, passRate: number, scoredCount = 4): ScorerAggregate {
  return {
    scorerId,
    dimension: "tool-use",
    meanValue: passRate,
    passRate,
    scoredCount,
    notApplicableCount: 4 - scoredCount,
    erroredCount: 0,
    measurementCount: 0,
    observations: 4,
  }
}

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    runId: "r",
    datasetId: "d",
    datasetVersion: 1,
    targetLabel: "t",
    k: 1,
    caseCount: 4,
    gradedCaseCount: 4,
    ungradedCaseCount: 0,
    scorers: { "tool-selection": agg("tool-selection", 1) },
    passAt1: 1,
    passHatK: 1,
    totalCostUsd: 0.1,
    avgLatencyMs: 100,
    createdAt: 0,
    scoringVersion: 2,
    ...overrides,
  }
}

describe("evaluateGate", () => {
  it("passes when all thresholds are met", () => {
    const result = evaluateGate(report(), { minPassHatK: 0.9, minPassAt1: 0.9 })
    expect(result.passed).toBe(true)
    expect(result.failures).toHaveLength(0)
  })

  it("fails when passHatK is below the floor", () => {
    const result = evaluateGate(report({ passHatK: 0.5 }), { minPassHatK: 0.9 })
    expect(result.passed).toBe(false)
    expect(result.failures.join(" ")).toContain("passHatK")
  })

  it("fails when a global scorer pass-rate floor is breached", () => {
    const result = evaluateGate(
      report({ scorers: { "tool-selection": agg("tool-selection", 0.5) } }),
      { minScorerPassRate: 0.8 }
    )
    expect(result.passed).toBe(false)
    expect(result.failures.join(" ")).toContain("tool-selection")
  })

  it("honors a per-scorer pass-rate floor", () => {
    const result = evaluateGate(report({ scorers: { a: agg("a", 0.7), b: agg("b", 1) } }), {
      minScorerPassRate: { a: 0.9 },
    })
    expect(result.passed).toBe(false)
    expect(result.failures.join(" ")).toContain("a")
  })

  it("fails when cost exceeds the cap", () => {
    const result = evaluateGate(report({ totalCostUsd: 5 }), { maxTotalCostUsd: 1 })
    expect(result.passed).toBe(false)
    expect(result.failures.join(" ")).toContain("cost")
  })

  it("ignores scorers absent from the report when a per-scorer floor names them", () => {
    const result = evaluateGate(report(), { minScorerPassRate: { "not-present": 0.9 } })
    expect(result.passed).toBe(true)
  })

  it("skips scorers that graded nothing instead of reading their 0% as a failure", () => {
    // The unbudgeted `cost` scorer only ever measures, so it reports
    // passRate 0 with scoredCount 0. Gating on that would fail every run that
    // simply doesn't budget cost.
    const result = evaluateGate(
      report({ scorers: { cost: agg("cost", 0, 0), "tool-selection": agg("tool-selection", 1) } }),
      { minScorerPassRate: 1 }
    )
    expect(result.passed).toBe(true)
  })

  it("still gates a legacy report that has no scoredCount", () => {
    const legacy = agg("tool-selection", 0.5)
    delete (legacy as Partial<ScorerAggregate>).scoredCount
    const result = evaluateGate(report({ scorers: { "tool-selection": legacy } }), {
      minScorerPassRate: 0.9,
    })
    expect(result.passed).toBe(false)
  })

  it("fails when too many cases were ungraded", () => {
    // 3 of 4 ungraded: the surviving case passes, so passAt1 is a perfect 1.0
    // over almost nothing. Without this guard that clears minPassAt1.
    const result = evaluateGate(
      report({ caseCount: 4, gradedCaseCount: 1, ungradedCaseCount: 3 }),
      {
        minPassAt1: 0.9,
        maxUngradedRatio: 0.2,
      }
    )
    expect(result.passed).toBe(false)
    expect(result.failures.join(" ")).toContain("ungraded")
  })

  it("passes the ungraded guard when the ratio is within budget", () => {
    const result = evaluateGate(
      report({ caseCount: 4, gradedCaseCount: 4, ungradedCaseCount: 0 }),
      {
        maxUngradedRatio: 0.2,
      }
    )
    expect(result.passed).toBe(true)
  })

  it("skips the ungraded guard on legacy reports that never counted them", () => {
    const legacy = report()
    delete (legacy as Partial<EvalReport>).ungradedCaseCount
    expect(evaluateGate(legacy, { maxUngradedRatio: 0 }).passed).toBe(true)
  })

  describe("inconclusive", () => {
    const nothingGraded = () =>
      report({ caseCount: 4, gradedCaseCount: 0, ungradedCaseCount: 4, passAt1: 0, passHatK: 0 })

    it("reports no evidence as inconclusive, not as a total failure", () => {
      // `passAt1` is 0 here because nothing was graded, not because the agent
      // got everything wrong. Reading that zero as a breached floor is how
      // "we learned nothing" used to be indistinguishable from "it failed".
      const result = evaluateGate(nothingGraded(), { minPassAt1: 0.9, minPassHatK: 0.9 })
      expect(result.verdict).toBe("inconclusive")
      expect(result.failures).toHaveLength(0)
      expect(result.inconclusiveReasons.join(" ")).toContain("no case produced a verdict")
    })

    it("keeps `passed` false for an inconclusive run so existing callers are unaffected", () => {
      expect(evaluateGate(nothingGraded(), { minPassAt1: 0.9 }).passed).toBe(false)
    })

    it("is inconclusive when a required scorer graded nothing", () => {
      const result = evaluateGate(
        report({
          scorers: { cost: agg("cost", 0, 0), "tool-selection": agg("tool-selection", 1) },
        }),
        { requiredScorerIds: ["cost"] }
      )
      expect(result.verdict).toBe("inconclusive")
      expect(result.inconclusiveReasons.join(" ")).toContain("cost")
    })

    it("is inconclusive when a required scorer never ran at all", () => {
      const result = evaluateGate(report(), { requiredScorerIds: ["judge-task-completion"] })
      expect(result.verdict).toBe("inconclusive")
      expect(result.inconclusiveReasons.join(" ")).toContain("judge-task-completion")
    })

    it("lets a real failure outrank missing evidence", () => {
      const result = evaluateGate(report({ totalCostUsd: 5 }), {
        maxTotalCostUsd: 1,
        requiredScorerIds: ["judge-task-completion"],
      })
      expect(result.verdict).toBe("fail")
      expect(result.failures.join(" ")).toContain("cost")
      expect(result.inconclusiveReasons).not.toHaveLength(0)
    })

    it("still passes a fully-graded run with its required scorers present", () => {
      const result = evaluateGate(report(), {
        minPassAt1: 0.9,
        requiredScorerIds: ["tool-selection"],
      })
      expect(result.verdict).toBe("pass")
      expect(result.passed).toBe(true)
      expect(result.inconclusiveReasons).toHaveLength(0)
    })
  })
})
