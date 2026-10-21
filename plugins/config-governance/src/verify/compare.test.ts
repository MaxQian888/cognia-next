import type { CheckResult } from "../adherence/backtest"
import type { EvalRecord } from "../runtime/store"
import { compareAdherence, compareEvals, readEvalOutcome } from "./compare"

function result(checkId: string, opportunities: number, followed: number): CheckResult {
  return {
    checkId,
    sessionsScanned: 1,
    sessionsTriggered: 1,
    opportunities,
    followed,
    violated: opportunities - followed,
    excluded: 0,
    samples: [],
  }
}

describe("compareAdherence", () => {
  it("says better, worse, same or insufficient", () => {
    const rows = compareAdherence(
      [
        result("a", 5, 1),
        result("b", 5, 4),
        result("c", 5, 3),
        result("d", 1, 0),
        result("e", 4, 2),
      ],
      [result("a", 5, 5), result("b", 5, 1), result("c", 5, 3), result("d", 5, 5)]
    )
    expect(rows.map((row) => [row.checkId, row.direction])).toEqual([
      ["a", "better"],
      ["b", "worse"],
      ["c", "same"],
      ["d", "insufficient"],
      ["e", "insufficient"],
    ])
    expect(rows[0]).toMatchObject({
      before: 0.2,
      after: 1,
      beforeOpportunities: 5,
      afterOpportunities: 5,
    })
    expect(rows[4]!.after).toBeUndefined()
  })
})

describe("compareEvals", () => {
  const record = (
    id: string,
    role: EvalRecord["role"],
    at: number,
    passAt1?: number,
    extra: Partial<EvalRecord> = {}
  ): EvalRecord => ({
    id,
    at,
    workspaceId: "w",
    role,
    datasetId: "d",
    model: "m",
    runIds: [],
    ...(passAt1 !== undefined ? { passAt1 } : {}),
    ...extra,
  })

  it("pairs each candidate with the latest earlier matching baseline", () => {
    const rows = compareEvals([
      record("b1", "baseline", 1, 0.5),
      record("b2", "baseline", 2, 0.6),
      record("c1", "candidate", 3, 0.8),
      record("b3", "baseline", 4, 0.1, { model: "other" }),
      record("c2", "candidate", 5, 0.62),
      record("c3", "candidate", 6),
      record("c0", "candidate", 0, 0.9),
    ])
    expect(rows.map((row) => [row.candidate.id, row.baseline.id, row.direction])).toEqual([
      ["c3", "b2", "insufficient"],
      ["c2", "b2", "same"],
      ["c1", "b2", "better"],
    ])
    expect(rows[2]!.delta).toBeCloseTo(0.2)
  })
})

describe("readEvalOutcome", () => {
  it("reads the fields it needs and nothing else", () => {
    expect(
      readEvalOutcome({ runIds: ["r", 3], passAt1: 0.5, totalCostUsd: 0.1, extra: 1 })
    ).toEqual({ runIds: ["r"], passAt1: 0.5, totalCostUsd: 0.1 })
    expect(readEvalOutcome(null)).toEqual({ runIds: [] })
  })
})
