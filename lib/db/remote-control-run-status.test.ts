import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  REMOTE_RUN_STATUS_MAX_ROWS,
  getRemoteRunStatus,
  listRemoteRunStatus,
  markRemoteRunStatus,
  pruneRemoteRunStatus,
  recordRemoteRunOutcome,
} from "./remote-control-run-status"
import type { RemoteControlRunStatusRow } from "@/types/remote-control"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("remote-control run status", () => {
  it("opens the v92 table and round-trips a row", async () => {
    // Exercising the table at all is the migration smoke test: a botched v92
    // upgrade would throw on the first read/write.
    const row = await recordRemoteRunOutcome({
      runId: "run_1",
      target: "workflow.run",
      status: "accepted",
      detail: "workflow wf_1",
      now: 1000,
    })
    expect(row.startedAt).toBe(1000)
    const fetched = await getRemoteRunStatus("run_1")
    expect(fetched).toEqual(
      expect.objectContaining({ runId: "run_1", status: "accepted", target: "workflow.run" })
    )
  })

  it("preserves startedAt across a replay (idempotent on runId)", async () => {
    await recordRemoteRunOutcome({
      runId: "run_1",
      target: "goal.create",
      status: "accepted",
      now: 1000,
    })
    await recordRemoteRunOutcome({
      runId: "run_1",
      target: "goal.create",
      status: "replayed",
      now: 2000,
    })
    const row = await getRemoteRunStatus("run_1")
    expect(row?.startedAt).toBe(1000)
    expect(row?.updatedAt).toBe(2000)
    expect(row?.status).toBe("replayed")
  })

  it("markRemoteRunStatus advances an existing row", async () => {
    await recordRemoteRunOutcome({
      runId: "run_1",
      target: "team.dispatch",
      status: "accepted",
      now: 1000,
    })
    await markRemoteRunStatus("run_1", "succeeded", "done", 3000)
    const row = await getRemoteRunStatus("run_1")
    expect(row?.status).toBe("succeeded")
    expect(row?.detail).toBe("done")
    expect(row?.updatedAt).toBe(3000)
  })

  it("markRemoteRunStatus is a no-op for an unknown runId", async () => {
    await markRemoteRunStatus("missing", "failed")
    expect(await getRemoteRunStatus("missing")).toBeUndefined()
  })

  it("lists newest-first by updatedAt", async () => {
    await recordRemoteRunOutcome({ runId: "a", target: "plan.run", status: "accepted", now: 1000 })
    await recordRemoteRunOutcome({ runId: "b", target: "plan.run", status: "accepted", now: 2000 })
    const rows = await listRemoteRunStatus(10)
    expect(rows.map((r) => r.runId)).toEqual(["b", "a"])
  })

  it("prune is a no-op under the cap", async () => {
    await recordRemoteRunOutcome({ runId: "a", target: "plan.run", status: "accepted" })
    await pruneRemoteRunStatus()
    expect(await getDb().remoteControlRunStatus.count()).toBe(1)
  })

  it("prune drops the oldest rows beyond the cap", async () => {
    const overflow = 5
    const total = REMOTE_RUN_STATUS_MAX_ROWS + overflow
    const rows: RemoteControlRunStatusRow[] = Array.from({ length: total }, (_, i) => ({
      runId: `run_${String(i).padStart(5, "0")}`,
      target: "plan.run",
      status: "accepted",
      startedAt: i,
      updatedAt: i, // ascending — the first `overflow` are oldest
    }))
    await getDb().remoteControlRunStatus.bulkPut(rows)
    await pruneRemoteRunStatus()
    expect(await getDb().remoteControlRunStatus.count()).toBe(REMOTE_RUN_STATUS_MAX_ROWS)
    // The five oldest (updatedAt 0..4) were dropped.
    expect(await getRemoteRunStatus("run_00000")).toBeUndefined()
    expect(await getRemoteRunStatus("run_00004")).toBeUndefined()
    expect(await getRemoteRunStatus("run_00005")).toBeDefined()
  })
})
