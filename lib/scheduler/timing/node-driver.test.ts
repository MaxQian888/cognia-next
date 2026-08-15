import { MAX_TIMEOUT_MS, NodeTimingDriver } from "./node-driver"

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { scheduler: stub }, createLogger: () => stub }
})

describe("NodeTimingDriver", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-08-16T00:00:00Z"))
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("is a sole-authority driver (no leader election) and starts synchronously", async () => {
    const driver = new NodeTimingDriver()
    expect(driver.supportsLeaderElection).toBe(false)
    await expect(driver.start()).resolves.toBeUndefined()
    driver.stop()
  })

  it("fires the due callback at the armed instant with the canonical fireAtMs", () => {
    const driver = new NodeTimingDriver()
    const due = jest.fn()
    driver.onDue(due)
    const fireAt = Date.now() + 5_000
    driver.arm("t1", fireAt)
    expect(driver.armedCount).toBe(1)
    jest.advanceTimersByTime(4_999)
    expect(due).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(due).toHaveBeenCalledWith("t1", fireAt)
    expect(driver.armedCount).toBe(0)
  })

  it("fires overdue arms on the next tick", () => {
    const driver = new NodeTimingDriver()
    const due = jest.fn()
    driver.onDue(due)
    driver.arm("late", Date.now() - 10_000)
    expect(due).not.toHaveBeenCalled()
    jest.advanceTimersByTime(0)
    expect(due).toHaveBeenCalledTimes(1)
  })

  it("re-arming replaces the pending timer; disarm cancels it", () => {
    const driver = new NodeTimingDriver()
    const due = jest.fn()
    driver.onDue(due)
    driver.arm("t1", Date.now() + 1_000)
    driver.arm("t1", Date.now() + 3_000)
    jest.advanceTimersByTime(1_500)
    expect(due).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1_500)
    expect(due).toHaveBeenCalledTimes(1)

    driver.arm("t2", Date.now() + 1_000)
    driver.disarm("t2")
    driver.disarm("never-armed")
    jest.advanceTimersByTime(2_000)
    expect(due).toHaveBeenCalledTimes(1)
  })

  it("stop clears every pending timer", () => {
    const driver = new NodeTimingDriver()
    const due = jest.fn()
    driver.onDue(due)
    driver.arm("a", Date.now() + 100)
    driver.arm("b", Date.now() + 200)
    expect(driver.armedCount).toBe(2)
    driver.stop()
    expect(driver.armedCount).toBe(0)
    jest.advanceTimersByTime(1_000)
    expect(due).not.toHaveBeenCalled()
  })

  it("chunks delays beyond the 32-bit setTimeout ceiling and re-evaluates on wake", () => {
    const setTimeoutSpy = jest.fn((cb: () => void, ms: number) => globalThis.setTimeout(cb, ms))
    const driver = new NodeTimingDriver({ setTimeout: setTimeoutSpy })
    const due = jest.fn()
    driver.onDue(due)
    const fireAt = Date.now() + MAX_TIMEOUT_MS + 60_000
    driver.arm("far", fireAt)
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMEOUT_MS)
    jest.advanceTimersByTime(MAX_TIMEOUT_MS)
    expect(due).not.toHaveBeenCalled()
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 60_000)
    jest.advanceTimersByTime(60_000)
    expect(due).toHaveBeenCalledWith("far", fireAt)
  })

  it("does not fire a stale timer whose entry was replaced while pending", () => {
    // Drive the timer host manually so we can invoke a captured callback
    // after the entry has been re-armed.
    const callbacks: Array<() => void> = []
    const driver = new NodeTimingDriver({
      setTimeout: (cb: () => void) => {
        callbacks.push(cb)
        return callbacks.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: jest.fn(),
      now: () => 0,
    })
    const due = jest.fn()
    driver.onDue(due)
    driver.arm("t", 10)
    driver.arm("t", 20)
    // The first (stale) callback must be a no-op.
    callbacks[0]()
    expect(due).not.toHaveBeenCalled()
    expect(driver.armedCount).toBe(1)
  })
})
