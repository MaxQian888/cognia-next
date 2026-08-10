import {
  registerSubagentCancellation,
  registerSubagentRun,
  unregisterSubagentRun,
  requestCancelSubagentRun,
  liveSubagentRunCount,
} from "./subagent-cancel-registry"

describe("subagent-cancel-registry", () => {
  it("registers, counts, and unregisters runs", () => {
    const ac = new AbortController()
    registerSubagentRun("r1", ac)
    expect(liveSubagentRunCount()).toBe(1)
    unregisterSubagentRun("r1")
    expect(liveSubagentRunCount()).toBe(0)
  })

  it("aborts a registered run and reports true", () => {
    const ac = new AbortController()
    registerSubagentRun("r2", ac)
    const ok = requestCancelSubagentRun("r2", "stop")
    expect(ok).toBe(true)
    expect(ac.signal.aborted).toBe(true)
    // The run is removed after cancellation.
    expect(liveSubagentRunCount()).toBe(0)
  })

  it("returns false when the run is unknown", () => {
    expect(requestCancelSubagentRun("missing")).toBe(false)
  })

  it("supports an async cancellation handler adapter", async () => {
    const cancel = jest.fn().mockResolvedValue(undefined)
    registerSubagentCancellation("sdk-task", cancel)

    expect(requestCancelSubagentRun("sdk-task", "stop native task")).toBe(true)
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledWith("stop native task")
    expect(liveSubagentRunCount()).toBe(0)
  })
})
