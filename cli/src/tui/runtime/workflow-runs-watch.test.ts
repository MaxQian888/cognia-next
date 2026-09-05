import { startRunsWatch } from "./workflow-runs-watch"
import type { WorkflowRunRow } from "@/types/workflow/visual"

const mockUnsubscribe = jest.fn()
const mockSubscribe = jest.fn(() => ({ unsubscribe: mockUnsubscribe }))
jest.mock("dexie", () => ({
  liveQuery: jest.fn(() => ({ subscribe: mockSubscribe })),
}))
jest.mock("@/lib/db/workflows", () => ({
  listWorkflowRuns: jest.fn(async () => []),
}))

const run = (id: string): WorkflowRunRow => ({ id, workflowId: "w1" }) as WorkflowRunRow

describe("startRunsWatch", () => {
  it("fences late and reentrant rows and unsubscribes only once after stop", () => {
    let emit: (rows: WorkflowRunRow[]) => void = () => {}
    const onRuns = jest.fn()
    const unsub = jest.fn(() => emit([run("a")]))
    const watch = startRunsWatch({
      workflowId: "w1",
      onRuns,
      subscribe: (_id, next) => {
        emit = next
        return unsub
      },
    })
    watch.stop()
    watch.stop()
    emit([run("b")])
    expect(onRuns).not.toHaveBeenCalled()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it("forwards each emitted run list to onRuns", () => {
    let emit: (r: WorkflowRunRow[]) => void = () => {}
    const seen: number[] = []
    startRunsWatch({
      workflowId: "w1",
      onRuns: (rows) => seen.push(rows.length),
      subscribe: (_id, next) => {
        emit = next
        return () => {}
      },
    })
    emit([run("a")])
    emit([run("a"), run("b")])
    expect(seen).toEqual([1, 2])
  })

  it("stop() unsubscribes", () => {
    const unsub = jest.fn()
    const watch = startRunsWatch({
      workflowId: "w1",
      onRuns: () => {},
      subscribe: () => unsub,
    })
    watch.stop()
    expect(unsub).toHaveBeenCalled()
  })

  it("swallows an unsubscribe error on stop()", () => {
    const watch = startRunsWatch({
      workflowId: "w1",
      onRuns: () => {},
      subscribe: () => () => {
        throw new Error("unsub blew up")
      },
    })
    expect(() => watch.stop()).not.toThrow()
  })

  it("swallows an onRuns consumer error", () => {
    let emit: (r: WorkflowRunRow[]) => void = () => {}
    startRunsWatch({
      workflowId: "w1",
      onRuns: () => {
        throw new Error("render boom")
      },
      subscribe: (_id, next) => {
        emit = next
        return () => {}
      },
    })
    expect(() => emit([run("a")])).not.toThrow()
  })

  it("degrades silently when subscribe throws", () => {
    expect(() =>
      startRunsWatch({
        workflowId: "w1",
        onRuns: () => {},
        subscribe: () => {
          throw new Error("no liveQuery")
        },
      })
    ).not.toThrow()
  })

  it("drives the default liveQuery seam", () => {
    const watch = startRunsWatch({ workflowId: "w1", onRuns: () => {} })
    expect(mockSubscribe).toHaveBeenCalled()
    watch.stop()
    expect(mockUnsubscribe).toHaveBeenCalled()
  })
})
