import type { EvalReport, ScorerAggregate } from "@/types/eval/eval"
import { evaluateGate } from "./gate"

function agg(scorerId: string, passRate: number): ScorerAggregate {
  return {
    scorerId,
    dimension: "tool-use",
    meanValue: passRate,
    passRate,
    errorCount: 0,
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
    scorers: { "tool-selection": agg("tool-selection", 1) },
    passAt1: 1,
    passHatK: 1,
    totalCostUsd: 0.1,
    avgLatencyMs: 100,
    createdAt: 0,
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
})
