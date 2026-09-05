/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import {
  LEGACY_RUN_NOT_RESUMABLE,
  backfillLegacyTeamRunHistory,
  isLegacyTeamRun,
  mapLegacyRunStatus,
} from "./legacy-run-history"

function legacyRow(over: Partial<WorkflowRunRow>): WorkflowRunRow {
  return {
    id: `wf-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "__team__:team-1:abc12345",
    projectId: "ws-1",
    status: "succeeded",
    triggerKind: "trigger.team",
    triggerPayload: { teamId: "team-1" },
    startedAt: 1_000,
    completedAt: 2_000,
    workflowSnapshot: { name: "Ship it" } as never,
    title: "Ship the thing",
    ...over,
  } as WorkflowRunRow
}

describe("legacy run history backfill", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("recognises synthesized team runs and nothing else", () => {
    expect(isLegacyTeamRun(legacyRow({}))).toBe(true)
    expect(
      isLegacyTeamRun(legacyRow({ triggerPayload: { teamId: "t", event: "team.completed" } }))
    ).toBe(false)
    expect(isLegacyTeamRun(legacyRow({ triggerKind: "trigger.manual" }))).toBe(false)
    expect(isLegacyTeamRun(legacyRow({ workflowId: "wf-plain" }))).toBe(false)
  })

  it("maps terminal statuses to immutable history and non-terminal ones to recovery", () => {
    expect(mapLegacyRunStatus("succeeded")).toMatchObject({
      durableStatus: "completed",
      terminalEvent: "run.completed",
    })
    expect(mapLegacyRunStatus("failed").terminalEvent).toBe("run.failed")
    expect(mapLegacyRunStatus("cancelled").terminalEvent).toBe("run.cancelled")
    for (const status of ["pending", "running", "waiting", "paused"] as const) {
      expect(mapLegacyRunStatus(status)).toEqual({
        durableStatus: "needs_input",
        executionStatus: "recovery_required",
        terminalEvent: "run.recovery_required",
        recoveryReason: LEGACY_RUN_NOT_RESUMABLE,
      })
    }
  })

  it("imports a completed legacy run as canonical, immutable history", async () => {
    const row = legacyRow({ id: "wf-done" })
    await getDb().workflowRuns.add(row)

    const outcome = await backfillLegacyTeamRunHistory(9_000)
    expect(outcome).toEqual({ scanned: 1, imported: 1, skipped: 0, recoveryRequired: 0 })

    const record = await getDb().agentTeamRuns.get("wf-done")
    expect(record).toMatchObject({
      teamId: "team-1",
      projectId: "ws-1",
      objective: "Ship the thing",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
    })
    const execution = await getDb().executionRuns.get("execution:team:wf-done")
    expect(execution).toMatchObject({ kind: "team", sourceId: "wf-done", status: "completed" })
    const events = await getDb()
      .executionRunEvents.where("runId")
      .equals("execution:team:wf-done")
      .sortBy("seq")
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.completed"])
    expect(events[0]?.payload).toEqual({ teamId: "team-1", origin: "legacy_backfill" })
    // Immutable: a settled journal takes no further events.
    expect(execution?.latestSnapshot?.allowedActions).toEqual(["open_details"])
  })

  it("turns a non-terminal legacy run into recovery_required that can only restart or stop", async () => {
    await getDb().workflowRuns.add(
      legacyRow({ id: "wf-live", status: "running", completedAt: undefined })
    )

    const outcome = await backfillLegacyTeamRunHistory(9_000)
    expect(outcome.recoveryRequired).toBe(1)

    const record = await getDb().agentTeamRuns.get("wf-live")
    expect(record).toMatchObject({
      status: "needs_input",
      recoveryReason: LEGACY_RUN_NOT_RESUMABLE,
    })
    const execution = await getDb().executionRuns.get("execution:team:wf-live")
    expect(execution?.status).toBe("recovery_required")
    expect(execution?.latestSnapshot?.allowedActions).toEqual(["stop", "open_details"])
    const events = await getDb()
      .executionRunEvents.where("runId")
      .equals("execution:team:wf-live")
      .sortBy("seq")
    expect(events[1]).toMatchObject({
      type: "run.recovery_required",
      payload: { reason: LEGACY_RUN_NOT_RESUMABLE },
    })
  })

  it("is idempotent and skips fan-out rows", async () => {
    await getDb().workflowRuns.bulkAdd([
      legacyRow({ id: "wf-a" }),
      legacyRow({ id: "wf-fanout", triggerPayload: { teamId: "team-1", event: "team.completed" } }),
    ])
    const first = await backfillLegacyTeamRunHistory(9_000)
    expect(first).toEqual({ scanned: 2, imported: 1, skipped: 1, recoveryRequired: 0 })
    const second = await backfillLegacyTeamRunHistory(9_500)
    expect(second).toEqual({ scanned: 2, imported: 0, skipped: 2, recoveryRequired: 0 })
    expect(await getDb().executionRuns.count()).toBe(1)
    expect(await getDb().executionRunEvents.count()).toBe(2)
  })

  it("leaves a run that already has canonical records alone", async () => {
    await getDb().workflowRuns.add(legacyRow({ id: "wf-dup" }))
    await getDb().executionRuns.add({
      id: "execution:team:wf-dup",
      kind: "team",
      sourceId: "wf-dup",
      title: "already here",
      status: "completed",
      currentRevision: 4,
      startedAt: 1,
      updatedAt: 2,
    })
    const outcome = await backfillLegacyTeamRunHistory()
    expect(outcome.imported).toBe(0)
    expect((await getDb().executionRuns.get("execution:team:wf-dup"))?.title).toBe("already here")
    expect(await getDb().agentTeamRuns.get("wf-dup")).toBeUndefined()
  })
})
