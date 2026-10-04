import {
  registerSubagentCancellation,
  registerSubagentRun,
  unregisterSubagentRun,
  requestCancelSubagentRun,
  requestCancelSubagentRunAndWait,
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

it("awaits async cancellation and reports a rejected receipt as failure", async () => {
  registerSubagentCancellation("failed-cancel", async () => {
    throw new Error("journal unavailable")
  })
  await expect(requestCancelSubagentRunAndWait("failed-cancel")).resolves.toBe(false)
  registerSubagentCancellation("saved-cancel", async () => undefined)
  await expect(requestCancelSubagentRunAndWait("saved-cancel")).resolves.toBe(true)
})
