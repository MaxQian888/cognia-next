/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { deriveRunStatusFromEvents, startRunStatusBridge } from "./run-status-bridge"
import type { NodeRunStatus, EditorState, EditorStore } from "@/lib/workflow/editor/store"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

// Constructing the Dexie instance costs ~1s+ per `__resetDbForTesting()` +
// `getDb()` cycle (see the note in lib/db/schema.ts), and the default 5s
// budget is not enough for that hook once the directory runs in parallel.
jest.setTimeout(30_000)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

// ---------------------------------------------------------------------------
// deriveRunStatusFromEvents — pure logic, exhaustive branch coverage.
// ---------------------------------------------------------------------------

function ev(
  partial: Partial<WorkflowRunEventRow> & Pick<WorkflowRunEventRow, "type" | "ts">
): WorkflowRunEventRow {
  return {
    id: `ev_${partial.ts}`,
    runId: "run_1",
    ...partial,
  }
}

describe("deriveRunStatusFromEvents", () => {
  it("returns an empty map for no step-scoped events", () => {
    expect(deriveRunStatusFromEvents([ev({ type: "run_started", ts: 1 })])).toEqual({})
  })

  it("maps step_started → running, step_completed → succeeded", () => {
    const out = deriveRunStatusFromEvents([
      ev({ type: "step_started", stepId: "n_a", ts: 1 }),
      ev({ type: "step_completed", stepId: "n_a", ts: 2 }),
    ])
    expect(out).toEqual({ n_a: "succeeded" })
  })

  it("maps step_failed → failed, step_skipped → skipped", () => {
    const out = deriveRunStatusFromEvents([
      ev({ type: "step_failed", stepId: "n_a", ts: 1 }),
      ev({ type: "step_skipped", stepId: "n_b", ts: 2 }),
    ])
    expect(out).toEqual({ n_a: "failed", n_b: "skipped" })
  })

  it("orders by ts so the latest event wins", () => {
    const out = deriveRunStatusFromEvents([
      ev({ type: "step_completed", stepId: "n_a", ts: 5 }),
      ev({ type: "step_started", stepId: "n_a", ts: 1 }),
    ])
    // Even though `step_started` is first in the array, `ts: 5` wins.
    expect(out).toEqual({ n_a: "succeeded" })
  })

  it("ignores events with no stepId", () => {
    const out = deriveRunStatusFromEvents([
      ev({ type: "step_started", ts: 1 }),
      ev({ type: "run_log", ts: 2 }),
    ])
    expect(out).toEqual({})
  })

  it("ignores run-level event types", () => {
    const out = deriveRunStatusFromEvents([
      ev({ type: "run_started", stepId: "n_a", ts: 1 }),
      ev({ type: "run_log", stepId: "n_a", ts: 2 }),
      ev({ type: "run_completed", stepId: "n_a", ts: 3 }),
    ])
    // None of these are step state transitions.
    expect(out).toEqual({})
  })

  it("does not mutate the input array", () => {
    const events = [
      ev({ type: "step_completed", stepId: "x", ts: 5 }),
      ev({ type: "step_started", stepId: "x", ts: 1 }),
    ]
    const before = [...events]
    deriveRunStatusFromEvents(events)
    expect(events).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// startRunStatusBridge — lifecycle + Dexie liveQuery integration.
// ---------------------------------------------------------------------------

interface FakeStoreState {
  clearRunStatus: jest.Mock
  setRunStatusBatch: jest.Mock<void, [Record<string, NodeRunStatus>]>
}

function makeFakeStore(): { store: EditorStore; state: FakeStoreState } {
  const state: FakeStoreState = {
    clearRunStatus: jest.fn(),
    setRunStatusBatch: jest.fn(),
  }
  const store = {
    getState: () => state as unknown as EditorState,
  } as unknown as EditorStore
  return { store, state }
}

async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

function makeRun(id: string, workflowId: string, startedAt: number): WorkflowRunRow {
  return {
    id,
    workflowId,
    status: "running",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt,
    workflowSnapshot: {
      id: workflowId,
      schemaVersion: 1,
      name: "wf",
      createdAt: startedAt,
      updatedAt: startedAt,
      nodes: [],
      edges: [],
      settings: {
        errorPolicy: "stop",
        timeoutMs: 0,
        concurrency: 1,
        retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      },
    },
  }
}

describe("startRunStatusBridge", () => {
  it("returns a function that unsubscribes both observables", async () => {
    const { store } = makeFakeStore()
    const stop = startRunStatusBridge({ workflowId: "wf_a", store })
    expect(typeof stop).toBe("function")
    stop()
  })

  it("clears run status when no run exists yet, then on the first new run", async () => {
    const { store, state } = makeFakeStore()
    const stop = startRunStatusBridge({ workflowId: "wf_a", store })
    await tick()
    // Pre-existing assertions: liveQuery emits at least once with `null` for
    // an empty table — but the bridge only calls clearRunStatus when it
    // SWITCHES from "had a run" to "no run". A pristine session begins at
    // lastRunId === null, so the initial empty emission is a no-op.
    expect(state.clearRunStatus).not.toHaveBeenCalled()

    // Insert a run; the bridge should observe it, mark it as the new
    // tracked run, and clear leftover state.
    await getDb().workflowRuns.put(makeRun("run_1", "wf_a", 1))
    await tick()
    expect(state.clearRunStatus).toHaveBeenCalled()

    stop()
  })

  it("ignores runs of unrelated workflows", async () => {
    const { store, state } = makeFakeStore()
    const stop = startRunStatusBridge({ workflowId: "wf_a", store })
    await tick()

    await getDb().workflowRuns.put(makeRun("run_other", "wf_b", 1))
    await tick()
    expect(state.clearRunStatus).not.toHaveBeenCalled()
    expect(state.setRunStatusBatch).not.toHaveBeenCalled()

    stop()
  })

  it("streams step statuses from the per-run events liveQuery", async () => {
    const { store, state } = makeFakeStore()
    const stop = startRunStatusBridge({ workflowId: "wf_a", store })
    await tick()

    await getDb().workflowRuns.put(makeRun("run_1", "wf_a", 1))
    // The events observable is opened lazily inside the runs observable's
    // `next` handler — it is a SECOND `Dexie.liveQuery` call that no other
    // test in this file reaches, and its failure is swallowed by the bridge's
    // `error()` arm. Assert on the emissions it produces so a broken binding
    // (see the interop note in lib/db/outbound-jobs.ts) cannot pass silently.
    await getDb().workflowRunEvents.bulkPut([
      { id: "ev_1", runId: "run_1", ts: 1, type: "step_started", stepId: "n_a" },
      { id: "ev_2", runId: "run_1", ts: 2, type: "step_completed", stepId: "n_a" },
      { id: "ev_3", runId: "run_1", ts: 3, type: "step_started", stepId: "n_b" },
    ] as WorkflowRunEventRow[])

    for (let i = 0; i < 40 && state.setRunStatusBatch.mock.calls.length === 0; i++) {
      await tick(20)
    }
    expect(state.setRunStatusBatch).toHaveBeenCalled()
    const latest =
      state.setRunStatusBatch.mock.calls[state.setRunStatusBatch.mock.calls.length - 1][0]
    expect(latest).toEqual({ n_a: "succeeded", n_b: "running" })

    stop()
  })

  it("keeps emitting as later events land on the tracked run", async () => {
    const { store, state } = makeFakeStore()
    const stop = startRunStatusBridge({ workflowId: "wf_a", store })
    await tick()

    await getDb().workflowRuns.put(makeRun("run_1", "wf_a", 1))
    await getDb().workflowRunEvents.put({
      id: "ev_1",
      runId: "run_1",
      ts: 1,
      type: "step_started",
      stepId: "n_a",
    } as WorkflowRunEventRow)
    for (let i = 0; i < 40 && state.setRunStatusBatch.mock.calls.length === 0; i++) {
      await tick(20)
    }
    state.setRunStatusBatch.mockClear()

    // A live subscription must pick this up; an initial-read-only
    // implementation would stall on the first emission.
    await getDb().workflowRunEvents.put({
      id: "ev_2",
      runId: "run_1",
      ts: 2,
      type: "step_failed",
      stepId: "n_a",
    } as WorkflowRunEventRow)
    for (let i = 0; i < 40 && state.setRunStatusBatch.mock.calls.length === 0; i++) {
      await tick(20)
    }
    const latest =
      state.setRunStatusBatch.mock.calls[state.setRunStatusBatch.mock.calls.length - 1][0]
    expect(latest).toEqual({ n_a: "failed" })

    stop()
  })

  it("does not double-clear when the same run row updates", async () => {
    const { store, state } = makeFakeStore()
    const stop = startRunStatusBridge({ workflowId: "wf_a", store })
    await tick()

    const run = makeRun("run_1", "wf_a", 1)
    await getDb().workflowRuns.put(run)
    // The first put's liveQuery emission is async — under fake-indexeddb
    // a fixed 30 ms tick is sometimes shorter than the emission window,
    // which races mockClear() past the first emit and lets the second
    // assertion observe a stale call. Wait until the bridge has actually
    // observed the first put before clearing the spy.
    for (let i = 0; i < 20 && state.clearRunStatus.mock.calls.length === 0; i++) {
      await tick(20)
    }
    expect(state.clearRunStatus).toHaveBeenCalled()
    state.clearRunStatus.mockClear()

    // Same run id, status patched — bridge should not treat it as a new run.
    await getDb().workflowRuns.put({ ...run, status: "succeeded" })
    await tick()
    expect(state.clearRunStatus).not.toHaveBeenCalled()

    stop()
  })
})
