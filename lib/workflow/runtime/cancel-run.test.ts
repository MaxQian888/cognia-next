/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const mockNotify = jest.fn(async (..._a: unknown[]) => undefined)
const mockTrackEvent = jest.fn().mockResolvedValue(true)
jest.mock("./companion-run-events", () => ({
  notifyCompanionsOfRunState: (...a: unknown[]) => mockNotify(...a),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}))

import { cancelWorkflowRun } from "./cancel-run"
import { registerRun, unregisterRun } from "./run-cancel-registry"
import { getExecutorId, __resetRunLeaseForTesting } from "./run-lease"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { WorkflowRunRow } from "@/types/workflow/visual"

jest.setTimeout(30_000)

function runRow(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: "run_c",
    workflowId: "wf_c",
    status: "running",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1,
    workflowSnapshot: {} as WorkflowRunRow["workflowSnapshot"],
    ...overrides,
  }
}

beforeAll(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

beforeEach(async () => {
  jest.clearAllMocks()
  __resetRunLeaseForTesting()
  await getDb().workflowRuns.clear()
})

describe("cancelWorkflowRun", () => {
  it("aborts a run live in this process", async () => {
    await getDb().workflowRuns.put(runRow())
    const ac = new AbortController()
    registerRun("run_c", ac)
    const result = await cancelWorkflowRun("run_c", "test")
    expect(result).toEqual({ cancelled: true, live: true, mode: "aborted" })
    expect(ac.signal.aborted).toBe(true)
    expect(mockTrackEvent).toHaveBeenCalledWith("workflow.run.cancelled", { runId: "run_c" })
    unregisterRun("run_c")
  })

  it("signals the owning executor via cancelRequestedAt when a live foreign lease exists", async () => {
    await getDb().workflowRuns.put(
      runRow({
        lease: { ownerId: "exec_other", claimedAt: Date.now(), expiresAt: Date.now() + 60_000 },
      })
    )
    const result = await cancelWorkflowRun("run_c", "test")
    expect(result).toEqual({ cancelled: true, live: false, mode: "lease-signalled" })
    const row = await getDb().workflowRuns.get("run_c")
    expect(row?.cancelRequestedAt).toEqual(expect.any(Number))
    expect(row?.status).toBe("running")
    expect(mockNotify).not.toHaveBeenCalled()
    expect(mockTrackEvent).toHaveBeenCalledWith("workflow.run.cancelled", { runId: "run_c" })
  })

  it("soft-cancels when nobody drives the run (stale lease) and fans out", async () => {
    await getDb().workflowRuns.put(
      runRow({ lease: { ownerId: "exec_dead", claimedAt: 1, expiresAt: 2 } })
    )
    const result = await cancelWorkflowRun("run_c", "test")
    expect(result).toEqual({ cancelled: true, live: false, mode: "soft-cancelled" })
    const row = await getDb().workflowRuns.get("run_c")
    expect(row?.status).toBe("cancelled")
    expect(row?.completedAt).toEqual(expect.any(Number))
    expect(mockNotify).toHaveBeenCalledWith({
      runId: "run_c",
      workflowId: "wf_c",
      status: "cancelled",
    })
    expect(mockTrackEvent).toHaveBeenCalledWith("workflow.run.cancelled", { runId: "run_c" })
  })

  it("soft-cancels a run leased by this very process id but not live (crashed loop)", async () => {
    await getDb().workflowRuns.put(
      runRow({
        lease: { ownerId: getExecutorId(), claimedAt: 1, expiresAt: Date.now() + 60_000 },
      })
    )
    const result = await cancelWorkflowRun("run_c", "test")
    expect(result.mode).toBe("soft-cancelled")
  })

  it("is a noop for terminal or unknown runs", async () => {
    await getDb().workflowRuns.put(runRow({ status: "succeeded" }))
    expect(await cancelWorkflowRun("run_c", "test")).toEqual({
      cancelled: false,
      live: false,
      mode: "noop",
    })
    expect(await cancelWorkflowRun("run_ghost", "test")).toMatchObject({ mode: "noop" })
    expect(mockTrackEvent).not.toHaveBeenCalled()
  })
})
