import { buildComparison } from "./compare"
import type { EvalReport } from "@/types/eval/eval"
import type { EvalRunCaseRow } from "@/lib/db/eval-run-cases"

const report = (runId: string): EvalReport =>
  ({
    runId,
    datasetId: "d",
    datasetVersion: 1,
    targetLabel: runId,
    k: 1,
    caseCount: 1,
    scorers: {},
    passAt1: 0,
    passHatK: 0,
    totalCostUsd: 0,
    avgLatencyMs: 0,
    createdAt: 0,
  }) as EvalReport

const row = (runId: string, caseId: string, passAt1: boolean): EvalRunCaseRow => ({
  id: `${runId}::${caseId}`,
  runId,
  caseId,
  scores: { s: { value: passAt1 ? 1 : 0, passed: passAt1 } },
  passAt1,
})

describe("buildComparison", () => {
  it("returns empty for no reports", () => {
    expect(buildComparison([], {})).toEqual({ runIds: [], rows: [] })
  })

  it("builds rows per case with per-run cells, delta + regression flags", () => {
    const reports = [report("A"), report("B")]
    const caseResultsByRun = {
      A: [row("A", "c1", true), row("A", "c2", true)],
      B: [row("B", "c1", false), row("B", "c2", true)],
    }
    const cmp = buildComparison(reports, caseResultsByRun, { c1: "hi", c2: "yo" })
    expect(cmp.runIds).toEqual(["A", "B"])
    expect(cmp.rows).toHaveLength(2)

    const c1 = cmp.rows.find((r) => r.caseId === "c1")!
    expect(c1.input).toBe("hi")
    // baseline cell: no delta, never a regression
    expect(c1.cells[0].delta).toBeUndefined()
    expect(c1.cells[0].regression).toBe(false)
    // B regressed on c1 (A passed, B failed)
    expect(c1.cells[1].delta).toBe(-1)
    expect(c1.cells[1].regression).toBe(true)

    const c2 = cmp.rows.find((r) => r.caseId === "c2")!
    expect(c2.cells[1].delta).toBe(0)
    expect(c2.cells[1].regression).toBe(false)
  })

  it("fills a missing cell with empty scores + passAt1 false", () => {
    const reports = [report("A"), report("B")]
    const caseResultsByRun = {
      A: [row("A", "c1", true)],
      B: [], // B has no result for c1
    }
    const cmp = buildComparison(reports, caseResultsByRun)
    const c1 = cmp.rows[0]
    expect(c1.cells[1].passAt1).toBe(false)
    expect(c1.cells[1].scores).toEqual({})
    expect(c1.cells[1].regression).toBe(true) // baseline passed, B "failed" (missing)
  })

  it("unions case ids across runs in first-seen order", () => {
    const reports = [report("A"), report("B")]
    const caseResultsByRun = {
      A: [row("A", "c1", true)],
      B: [row("B", "c2", true)],
    }
    const cmp = buildComparison(reports, caseResultsByRun)
    expect(cmp.rows.map((r) => r.caseId)).toEqual(["c1", "c2"])
  })
})
