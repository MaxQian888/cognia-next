/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  EMPTY_STEP_STREAM,
  getStepStream,
  reduceStepStream,
  useStepStream,
} from "./use-step-stream"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

function ev(partial: Partial<WorkflowRunEventRow> & Pick<WorkflowRunEventRow, "ts" | "type">) {
  return {
    id: `evt_${partial.ts}_${partial.type}`,
    runId: "run1",
    stepId: "n1",
    ...partial,
  } as WorkflowRunEventRow
}

describe("reduceStepStream", () => {
  it("returns the empty state for a null stepId", () => {
    expect(reduceStepStream([], null)).toEqual(EMPTY_STEP_STREAM)
  })

  it("concatenates chunks in ts order while the step is running", () => {
    const state = reduceStepStream(
      [
        ev({ ts: 10, type: "step_started" }),
        ev({ ts: 12, type: "step_stream", payload: { delta: "Hel", seq: 0 } }),
        ev({ ts: 14, type: "step_stream", payload: { delta: "lo", seq: 1 } }),
      ],
      "n1"
    )
    expect(state.text).toBe("Hello")
    expect(state.isStreaming).toBe(true)
    expect(state.chunkCount).toBe(2)
  })

  it("stops streaming once a terminal event lands", () => {
    const state = reduceStepStream(
      [
        ev({ ts: 10, type: "step_started" }),
        ev({ ts: 12, type: "step_stream", payload: { delta: "x", seq: 0 } }),
        ev({ ts: 20, type: "step_completed", payload: { output: { completion: "x" } } }),
      ],
      "n1"
    )
    expect(state.isStreaming).toBe(false)
    expect(state.text).toBe("x")
  })

  it("only counts chunks from the latest attempt (retry-aware)", () => {
    const state = reduceStepStream(
      [
        ev({ ts: 10, type: "step_started" }),
        ev({ ts: 12, type: "step_stream", payload: { delta: "old", seq: 0 } }),
        ev({ ts: 14, type: "step_failed", payload: { message: "boom" } }),
        ev({ ts: 20, type: "step_started" }),
        ev({ ts: 22, type: "step_stream", payload: { delta: "new", seq: 0 } }),
      ],
      "n1"
    )
    expect(state.text).toBe("new")
    expect(state.isStreaming).toBe(true)
  })

  it("ignores events from other steps and tolerates malformed payloads", () => {
    const state = reduceStepStream(
      [
        ev({ ts: 10, type: "step_started" }),
        ev({ ts: 11, type: "step_stream", stepId: "other", payload: { delta: "zzz", seq: 0 } }),
        ev({ ts: 12, type: "step_stream", payload: undefined }),
      ],
      "n1"
    )
    expect(state.text).toBe("")
    expect(state.chunkCount).toBe(1)
  })
})

describe("getStepStream / useStepStream", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
  })

  function makeRun(id: string, workflowId: string, startedAt: number): WorkflowRunRow {
    return {
      id,
      workflowId,
      status: "running",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt,
      workflowSnapshot: {} as WorkflowRunRow["workflowSnapshot"],
    }
  }

  it("returns the empty state without ids or runs", async () => {
    expect(await getStepStream(undefined, "n1")).toEqual(EMPTY_STEP_STREAM)
    expect(await getStepStream("wf1", null)).toEqual(EMPTY_STEP_STREAM)
    expect(await getStepStream("wf_none", "n1")).toEqual(EMPTY_STEP_STREAM)
  })

  it("reads the latest run's stream chunks from Dexie", async () => {
    await getDb().workflowRuns.put(makeRun("run_old", "wf1", 100))
    await getDb().workflowRuns.put(makeRun("run_new", "wf1", 200))
    await getDb().workflowRunEvents.bulkPut([
      { id: "e1", runId: "run_new", ts: 201, type: "step_started", stepId: "n1" },
      {
        id: "e2",
        runId: "run_new",
        ts: 202,
        type: "step_stream",
        stepId: "n1",
        payload: { delta: "live", seq: 0 },
      },
      // Older run noise must not leak in.
      {
        id: "e3",
        runId: "run_old",
        ts: 101,
        type: "step_stream",
        stepId: "n1",
        payload: { delta: "stale", seq: 0 },
      },
    ])
    const state = await getStepStream("wf1", "n1")
    expect(state.text).toBe("live")
    expect(state.isStreaming).toBe(true)
  })

  it("useStepStream surfaces the live state when enabled", async () => {
    await getDb().workflowRuns.put(makeRun("run1", "wf1", 100))
    await getDb().workflowRunEvents.bulkPut([
      { id: "e1", runId: "run1", ts: 101, type: "step_started", stepId: "n1" },
      {
        id: "e2",
        runId: "run1",
        ts: 102,
        type: "step_stream",
        stepId: "n1",
        payload: { delta: "abc", seq: 0 },
      },
    ])
    const { result } = renderHook(() => useStepStream("wf1", "n1", true))
    await waitFor(() => expect(result.current.text).toBe("abc"))
    expect(result.current.isStreaming).toBe(true)
  })

  it("useStepStream stays empty while disabled", async () => {
    const { result } = renderHook(() => useStepStream("wf1", "n1", false))
    expect(result.current).toEqual(EMPTY_STEP_STREAM)
  })
})
