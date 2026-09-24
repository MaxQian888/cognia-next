/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import { createExecutionRun } from "@/lib/db/execution-runs"
import type { ExecutionRun, ExecutionRunStatus } from "@/types/execution/run"
import { isSettledSquadRunStatus, watchSquadRunSettlement } from "./watch-squad-run"

const RUN_ID = "execution:team:run_team_abc"

function run(status: ExecutionRunStatus): ExecutionRun {
  const now = Date.now()
  return {
    id: RUN_ID,
    kind: "team",
    sourceId: "run_team_abc",
    title: "Ship it",
    status,
    currentRevision: 0,
    startedAt: now,
    updatedAt: now,
  } as ExecutionRun
}

beforeEach(async () => {
  await getDb().executionRuns.clear()
}, 30_000)

describe("isSettledSquadRunStatus", () => {
  it("treats only the three terminal statuses as settled", () => {
    for (const s of ["completed", "failed", "cancelled"] as const) {
      expect(isSettledSquadRunStatus(s)).toBe(true)
    }
    // `paused` is deliberately NOT terminal: a paused Squad is still this
    // conversation's turn and the user can steer it.
    for (const s of ["queued", "running", "waiting", "paused", "recovery_required"] as const) {
      expect(isSettledSquadRunStatus(s)).toBe(false)
    }
  })
})

describe("watchSquadRunSettlement", () => {
  it("settles immediately when the run is already over", async () => {
    await createExecutionRun(run("completed"))
    const onSettled = jest.fn()
    const dispose = watchSquadRunSettlement({
      executionRunId: RUN_ID,
      onSettled,
      subscribeDexie: false,
      pollIntervalMs: 10,
    })
    await new Promise((r) => setTimeout(r, 30))
    dispose()
    expect(onSettled).toHaveBeenCalledWith("completed")
  })

  it("keeps holding while the run is live, then fires once when it ends", async () => {
    await createExecutionRun(run("running"))
    const onSettled = jest.fn()
    const dispose = watchSquadRunSettlement({
      executionRunId: RUN_ID,
      onSettled,
      subscribeDexie: false,
      pollIntervalMs: 10,
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(onSettled).not.toHaveBeenCalled()

    await getDb().executionRuns.update(RUN_ID, { status: "failed" })
    await new Promise((r) => setTimeout(r, 40))
    dispose()
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith("failed")
  })

  it("does not settle on a pause", async () => {
    await createExecutionRun(run("paused"))
    const onSettled = jest.fn()
    const dispose = watchSquadRunSettlement({
      executionRunId: RUN_ID,
      onSettled,
      subscribeDexie: false,
      pollIntervalMs: 10,
    })
    await new Promise((r) => setTimeout(r, 40))
    dispose()
    expect(onSettled).not.toHaveBeenCalled()
  })

  it("stops polling once disposed", async () => {
    await createExecutionRun(run("running"))
    const onSettled = jest.fn()
    const dispose = watchSquadRunSettlement({
      executionRunId: RUN_ID,
      onSettled,
      subscribeDexie: false,
      pollIntervalMs: 10,
    })
    dispose()
    await getDb().executionRuns.update(RUN_ID, { status: "completed" })
    await new Promise((r) => setTimeout(r, 40))
    expect(onSettled).not.toHaveBeenCalled()
    // Disposing twice is safe.
    expect(() => dispose()).not.toThrow()
  })

  it("waits rather than settling when the run row is not there yet", async () => {
    // The watcher can be armed before the bridge has written the row.
    const onSettled = jest.fn()
    const dispose = watchSquadRunSettlement({
      executionRunId: RUN_ID,
      onSettled,
      subscribeDexie: false,
      pollIntervalMs: 10,
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(onSettled).not.toHaveBeenCalled()

    await createExecutionRun(run("completed"))
    await new Promise((r) => setTimeout(r, 40))
    dispose()
    expect(onSettled).toHaveBeenCalledWith("completed")
  })
})
