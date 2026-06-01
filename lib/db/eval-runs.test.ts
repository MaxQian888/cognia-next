import "fake-indexeddb/auto"
import type { EvalReport } from "@/types/eval/eval"
import {
  saveRun,
  getRun,
  listRunsByDataset,
  listRecentRuns,
  deleteRun,
  deleteRunsForDataset,
} from "./eval-runs"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().evalRuns.clear()
})

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    runId: "run_" + Math.random().toString(36).slice(2, 8),
    datasetId: "d1",
    datasetVersion: 1,
    targetLabel: "opus",
    k: 1,
    caseCount: 3,
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
})
