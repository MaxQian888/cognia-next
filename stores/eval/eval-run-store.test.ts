import { useEvalRunStore } from "./eval-run-store"

const reset = () => useEvalRunStore.setState({ active: null, controller: null })
beforeEach(reset)

function startRun(label = "opus") {
  const controller = new AbortController()
  useEvalRunStore.getState().start({ datasetId: "d1", label, controller })
  return controller
}

describe("useEvalRunStore", () => {
  it("starts idle", () => {
    expect(useEvalRunStore.getState().active).toBeNull()
  })

  it("tracks the active run without exposing the controller in rendered state", () => {
    const controller = startRun()
    const { active } = useEvalRunStore.getState()
    expect(active).toEqual({
      datasetId: "d1",
      label: "opus",
      progress: null,
      cancelling: false,
    })
    // The AbortController is not serializable and must stay out of `active`.
    expect(JSON.stringify(active)).not.toContain("AbortController")
    expect(useEvalRunStore.getState().controller).toBe(controller)
  })

  it("records progress ticks", () => {
    startRun()
    useEvalRunStore.getState().updateProgress({ done: 3, total: 10, passing: 2, ungraded: 1 })
    expect(useEvalRunStore.getState().active?.progress).toEqual({
      done: 3,
      total: 10,
      passing: 2,
      ungraded: 1,
    })
  })

  it("ignores progress when no run is active", () => {
    useEvalRunStore.getState().updateProgress({ done: 1, total: 1, passing: 1, ungraded: 0 })
    expect(useEvalRunStore.getState().active).toBeNull()
  })

  it("aborts on cancel — even before the first progress tick", () => {
    // The whole point: the old dialog gated its cancel button on `progress`,
    // so during case 1 there was no way out.
    const controller = startRun()
    expect(useEvalRunStore.getState().active?.progress).toBeNull()
    useEvalRunStore.getState().cancel()
    expect(controller.signal.aborted).toBe(true)
    expect(useEvalRunStore.getState().active?.cancelling).toBe(true)
  })

  it("is a no-op to cancel with nothing running", () => {
    expect(() => useEvalRunStore.getState().cancel()).not.toThrow()
    expect(useEvalRunStore.getState().active).toBeNull()
  })

  it("clears both the run and its controller on finish", () => {
    startRun()
    useEvalRunStore.getState().finish()
    expect(useEvalRunStore.getState().active).toBeNull()
    expect(useEvalRunStore.getState().controller).toBeNull()
  })

  it("replaces the previous run when a new one starts", () => {
    startRun("first")
    const second = startRun("second")
    expect(useEvalRunStore.getState().active?.label).toBe("second")
    expect(useEvalRunStore.getState().controller).toBe(second)
  })
})
