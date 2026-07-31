/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  saveCalibrationRun,
  getCalibrationRun,
  listRunsBySet,
  listRecentCalibrationRuns,
  deleteCalibrationRun,
  deleteRunsBySet,
  type CalibrationRunRow,
} from "./calibration-runs"
import { computeAgreement } from "@/lib/ai/eval/calibration/metrics"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().calibrationRuns.clear()
})

function run(overrides: Partial<CalibrationRunRow> = {}): CalibrationRunRow {
  return {
    runId: "calrun_x",
    setId: "set-a",
    criterion: "task completion",
    rubric: "Pass only if complete.",
    judgeModel: "claude-sonnet-4-6",
    itemCount: 2,
    scoredCount: 2,
    erroredCount: 0,
    metrics: computeAgreement([
      { gold: true, judge: true },
      { gold: false, judge: false },
    ]),
    verdicts: [
      { itemId: "i1", goldLabel: "pass", judgeValue: 1, judgePassed: true, errored: false },
      { itemId: "i2", goldLabel: "fail", judgeValue: 0, judgePassed: false, errored: false },
    ],
    createdAt: 100,
    ...overrides,
  }
}

describe("calibration runs", () => {
  it("saves and reads back a run with inlined metrics + verdicts", async () => {
    await saveCalibrationRun(run())
    const got = await getCalibrationRun("calrun_x")
    expect(got).toBeDefined()
    expect(got?.metrics.cohenKappa).toBe(1)
    expect(got?.verdicts).toHaveLength(2)
  })

  it("returns undefined for empty/missing runId", async () => {
    expect(await getCalibrationRun("")).toBeUndefined()
    expect(await getCalibrationRun("nope")).toBeUndefined()
  })

  it("lists runs for a set newest-first", async () => {
    await saveCalibrationRun(run({ runId: "r1", createdAt: 1 }))
    await saveCalibrationRun(run({ runId: "r2", createdAt: 2 }))
    await saveCalibrationRun(run({ runId: "r3", setId: "set-b", createdAt: 3 }))
    const rows = await listRunsBySet("set-a")
    expect(rows.map((r) => r.runId)).toEqual(["r2", "r1"])
  })

  it("lists recent runs across calibration sets", async () => {
    await saveCalibrationRun(run({ runId: "r1", createdAt: 1 }))
    await saveCalibrationRun(run({ runId: "r2", setId: "set-b", createdAt: 3 }))
    await saveCalibrationRun(run({ runId: "r3", createdAt: 2 }))

    expect((await listRecentCalibrationRuns(2)).map((item) => item.runId)).toEqual(["r2", "r3"])
    expect(await listRecentCalibrationRuns(0)).toEqual([])
  })

  it("returns [] for empty setId", async () => {
    expect(await listRunsBySet("")).toEqual([])
  })

  it("deletes a single run and a whole set", async () => {
    await saveCalibrationRun(run({ runId: "r1", setId: "set-a", createdAt: 1 }))
    await saveCalibrationRun(run({ runId: "r2", setId: "set-a", createdAt: 2 }))
    await saveCalibrationRun(run({ runId: "r3", setId: "set-b", createdAt: 3 }))

    await deleteCalibrationRun("r1")
    expect(await listRunsBySet("set-a")).toHaveLength(1)

    await deleteRunsBySet("set-a")
    expect(await listRunsBySet("set-a")).toHaveLength(0)
    expect(await listRunsBySet("set-b")).toHaveLength(1)
  })

  it("delete guards ignore empty ids", async () => {
    await expect(deleteCalibrationRun("")).resolves.toBeUndefined()
    await expect(deleteRunsBySet("")).resolves.toBeUndefined()
  })
})
