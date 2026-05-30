import { liveRunCount, registerRun, requestCancelRun, unregisterRun } from "./run-cancel-registry"

describe("run-cancel-registry", () => {
  it("aborts a registered run and reports it was live", () => {
    const ac = new AbortController()
    registerRun("run-1", ac)
    expect(liveRunCount()).toBe(1)

    const fired = requestCancelRun("run-1", "stop it")
    expect(fired).toBe(true)
    expect(ac.signal.aborted).toBe(true)
    // The controller is dropped after firing so a second cancel is a no-op.
    expect(liveRunCount()).toBe(0)
    expect(requestCancelRun("run-1")).toBe(false)
  })

  it("returns false for an unknown run", () => {
    expect(requestCancelRun("nope")).toBe(false)
  })

  it("unregister removes a run without aborting", () => {
    const ac = new AbortController()
    registerRun("run-2", ac)
    unregisterRun("run-2")
    expect(ac.signal.aborted).toBe(false)
    expect(requestCancelRun("run-2")).toBe(false)
  })

  it("uses the provided reason on the abort", () => {
    const ac = new AbortController()
    registerRun("run-3", ac)
    requestCancelRun("run-3", "because")
    expect((ac.signal.reason as Error)?.message).toContain("because")
  })
})
