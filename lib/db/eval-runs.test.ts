import type { EvalReport } from "@/types/eval/eval"
import {
  saveRun,
  getRun,
  listRunsByDataset,
  listRecentRuns,
  deleteRun,
  deleteRunsForDataset,
} from "./eval-runs"
import { saveCaseResult, listCaseResults } from "./eval-run-cases"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().evalRuns.clear()
  await getDb().evalRunCaseResults.clear()
})
afterAll(dbFixture.dispose)

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    runId: "run_" + Math.random().toString(36).slice(2, 8),
    datasetId: "d1",
    datasetVersion: 1,
    targetLabel: "opus",
    k: 1,
    caseCount: 3,
    gradedCaseCount: 3,
    ungradedCaseCount: 0,
    scorers: {},
    passAt1: 0.66,
    passHatK: 0.66,
    totalCostUsd: 0.1,
    avgLatencyMs: 200,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("eval run persistence", () => {
  it("saves and reads a run keyed by runId", async () => {
    const r = report({ runId: "run-abc" })
    await saveRun(r)
    expect(await getRun("run-abc")).toMatchObject({ runId: "run-abc", passHatK: 0.66 })
  })

  it("lists runs for a dataset newest-first", async () => {
    await saveRun(report({ runId: "old", datasetId: "d1", createdAt: 1 }))
    await saveRun(report({ runId: "new", datasetId: "d1", createdAt: 2 }))
    await saveRun(report({ runId: "other", datasetId: "d2", createdAt: 3 }))
    const runs = await listRunsByDataset("d1")
    expect(runs.map((r) => r.runId)).toEqual(["new", "old"])
  })

  it("lists recent runs across datasets honoring the limit", async () => {
    await saveRun(report({ runId: "a", createdAt: 1 }))
    await saveRun(report({ runId: "b", createdAt: 2 }))
    await saveRun(report({ runId: "c", createdAt: 3 }))
    const recent = await listRecentRuns(2)
    expect(recent.map((r) => r.runId)).toEqual(["c", "b"])
  })

  it("deletes a single run and all runs for a dataset", async () => {
    await saveRun(report({ runId: "a", datasetId: "d1" }))
    await saveRun(report({ runId: "b", datasetId: "d1" }))
    await deleteRun("a")
    expect(await getRun("a")).toBeUndefined()
    await deleteRunsForDataset("d1")
    expect(await listRunsByDataset("d1")).toHaveLength(0)
  })

  it("deleteRun cascades the run's per-case verdicts", async () => {
    await saveRun(report({ runId: "a", datasetId: "d1" }))
    await saveCaseResult({ runId: "a", caseId: "c1", scores: {}, passAt1: true })
    await saveCaseResult({ runId: "a", caseId: "c2", scores: {}, passAt1: false })
    expect(await listCaseResults("a")).toHaveLength(2)
    await deleteRun("a")
    expect(await getRun("a")).toBeUndefined()
    expect(await listCaseResults("a")).toHaveLength(0)
  })

  it("deleteRunsForDataset cascades case verdicts for every run it removes", async () => {
    await saveRun(report({ runId: "a", datasetId: "d1" }))
    await saveRun(report({ runId: "b", datasetId: "d1" }))
    await saveRun(report({ runId: "keep", datasetId: "d2" }))
    await saveCaseResult({ runId: "a", caseId: "c1", scores: {}, passAt1: true })
    await saveCaseResult({ runId: "b", caseId: "c1", scores: {}, passAt1: true })
    await saveCaseResult({ runId: "keep", caseId: "c1", scores: {}, passAt1: true })
    await deleteRunsForDataset("d1")
    expect(await listCaseResults("a")).toHaveLength(0)
    expect(await listCaseResults("b")).toHaveLength(0)
    // A run that belongs to another dataset keeps its verdicts.
    expect(await listCaseResults("keep")).toHaveLength(1)
  })
})
