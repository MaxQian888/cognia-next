import { startRunWatch } from "./workflow-run-watch"
import type { RunStepView } from "./workflow-run-fold"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

// Mock the live seams so the default (liveQuery) subscribe path is exercised
// without a real IndexedDB. `liveQuery` returns an observable whose `subscribe`
// we drive; `listRunEvents` is the querier the observable would call.
const mockUnsubscribe = jest.fn()
const mockSubscribe = jest.fn(() => ({ unsubscribe: mockUnsubscribe }))
jest.mock("dexie", () => ({
  liveQuery: jest.fn(() => ({ subscribe: mockSubscribe })),
}))
jest.mock("@/lib/workflow/runtime/event-log", () => ({
  listRunEvents: jest.fn(async () => []),
}))

const init: RunStepView[] = [
  { id: "a", label: "A", status: "pending" },
  { id: "b", label: "B", status: "pending" },
]

function evt(type: WorkflowRunEventRow["type"], stepId: string, ts: number): WorkflowRunEventRow {
  return { id: "e" + ts, runId: "r1", type, stepId, ts } as WorkflowRunEventRow
}

describe("startRunWatch", () => {
  it("folds each emit and calls onState with the derived state", () => {
    let emit: (e: WorkflowRunEventRow[]) => void = () => {}
    const states: number[] = []
    const watch = startRunWatch({
      runId: "r1",
      initial: init,
      onState: (s) => states.push(s.completed),
      subscribe: (_runId, next) => {
        emit = next
        return () => {}
      },
    })
    emit([evt("step_started", "a", 1)])
    emit([evt("step_started", "a", 1), evt("step_completed", "a", 3)])
    watch.stop()
    expect(states).toEqual([0, 1])
  })

  it("stop() invokes the unsubscribe returned by subscribe", () => {
    const unsub = jest.fn()
    const watch = startRunWatch({
      runId: "r1",
      initial: init,
      onState: () => {},
      subscribe: () => unsub,
    })
    watch.stop()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it("degrades silently when subscribe throws", () => {
    const onState = jest.fn()
    const watch = startRunWatch({
      runId: "r1",
      initial: init,
      onState,
      subscribe: () => {
        throw new Error("liveQuery unavailable")
      },
    })
    expect(onState).not.toHaveBeenCalled()
    expect(() => watch.stop()).not.toThrow()
  })

  it("swallows a malformed onState consumer error so the run is unaffected", () => {
    let emit: (e: WorkflowRunEventRow[]) => void = () => {}
    const watch = startRunWatch({
      runId: "r1",
      initial: init,
      onState: () => {
        throw new Error("render blew up")
      },
      subscribe: (_runId, next) => {
        emit = next
        return () => {}
      },
    })
    expect(() => emit([evt("step_started", "a", 1)])).not.toThrow()
    watch.stop()
  })

  it("swallows an error thrown by the unsubscribe function", () => {
    const watch = startRunWatch({
      runId: "r1",
      initial: init,
      onState: () => {},
      subscribe: () => () => {
        throw new Error("unsub blew up")
      },
    })
    expect(() => watch.stop()).not.toThrow()
  })

  it("default subscribe wraps Dexie liveQuery and stop() unsubscribes", () => {
    const watch = startRunWatch({ runId: "r1", initial: init, onState: () => {} })
    // liveQuery(...).subscribe was wired with next + error handlers.
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    const arg = mockSubscribe.mock.calls[0][0] as {
      next: (e: WorkflowRunEventRow[]) => void
      error: (err: unknown) => void
    }
    expect(typeof arg.next).toBe("function")
    expect(typeof arg.error).toBe("function")
    // The error handler is a no-op (must never throw).
    expect(() => arg.error(new Error("x"))).not.toThrow()
    watch.stop()
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
  })
})
