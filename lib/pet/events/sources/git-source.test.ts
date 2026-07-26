import { createGitSource, wireGitSource, type GitActivitySnapshot } from "./git-source"
import { useGitStore } from "@/stores/git/git-store"

function snapshot(
  activeOps: GitActivitySnapshot["activeOps"] = [],
  failedOp: GitActivitySnapshot["failedOp"] = null
): GitActivitySnapshot {
  return { activeOps, failedOp }
}

describe("createGitSource", () => {
  it("emits one thinking edge and waits for the whole concurrent batch to settle", () => {
    let current = snapshot()
    let onChange: () => void = () => {
      throw new Error("Subscriber was not wired")
    }
    const dispose = jest.fn()
    const emit = jest.fn()
    const wire = createGitSource({
      getSnapshot: () => current,
      subscribe: (listener) => {
        onChange = listener
        return dispose
      },
    })

    const stop = wire(emit)
    current = snapshot(["commit"])
    onChange()
    current = snapshot(["commit", "push"])
    onChange()
    current = snapshot(["push"])
    onChange()

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenLastCalledWith({
      source: "source-control",
      kind: "thinking",
      xp: 0,
      meta: { activeCount: 1, op: "commit" },
    })

    current = snapshot()
    onChange()
    expect(emit).toHaveBeenLastCalledWith({
      source: "source-control",
      kind: "success",
      xp: 2,
      meta: { activeCount: 0, op: "push" },
    })

    stop()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("surfaces a failed operation without leaking its error message", () => {
    let current = snapshot()
    let onChange: () => void = () => {}
    const emit = jest.fn()
    const wire = createGitSource({
      getSnapshot: () => current,
      subscribe: (listener) => {
        onChange = listener
        return () => {}
      },
    })

    wire(emit)
    current = snapshot(["pull"])
    onChange()
    current = snapshot(["pull"], "pull")
    onChange()
    current = snapshot([], "pull")
    onChange()

    expect(emit).toHaveBeenLastCalledWith({
      source: "source-control",
      kind: "error",
      xp: 0,
      meta: { activeCount: 0, op: "pull" },
    })
    expect(JSON.stringify(emit.mock.calls)).not.toContain("message")
  })

  it("does not carry a stale error into the next successful batch", () => {
    let current = snapshot([], "push")
    let onChange: () => void = () => {}
    const emit = jest.fn()
    const wire = createGitSource({
      getSnapshot: () => current,
      subscribe: (listener) => {
        onChange = listener
        return () => {}
      },
    })

    wire(emit)
    // useGitActions sets the op before it clears the previous error.
    current = snapshot(["push"], "push")
    onChange()
    current = snapshot(["push"], null)
    onChange()
    current = snapshot()
    onChange()

    expect(emit).toHaveBeenLastCalledWith({
      source: "source-control",
      kind: "success",
      xp: 2,
      meta: { activeCount: 0, op: "push" },
    })
  })

  it("ignores an operation that was already running before wiring", () => {
    let onChange: () => void = () => {}
    const emit = jest.fn()
    const wire = createGitSource({
      getSnapshot: () => snapshot(["fetch"]),
      subscribe: (listener) => {
        onChange = listener
        return () => {}
      },
    })

    wire(emit)
    onChange()

    expect(emit).not.toHaveBeenCalled()
  })

  it("uses the production Git-store subscription and detaches cleanly", () => {
    useGitStore.getState().reset()
    const emit = jest.fn()
    const stop = wireGitSource(emit)

    useGitStore.getState().setOp("commit", true)
    useGitStore.getState().clearError()
    useGitStore.getState().setOp("commit", false)

    expect(emit.mock.calls.map(([event]) => event.kind)).toEqual(["thinking", "success"])

    stop()
    useGitStore.getState().setOp("push", true)
    expect(emit).toHaveBeenCalledTimes(2)
    useGitStore.getState().reset()
  })
})
