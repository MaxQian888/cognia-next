/**
 * @jest-environment jsdom
 */

import { RendererTimingDriver } from "./renderer-driver"

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { scheduler: stub }, createLogger: () => stub }
})

const startLeaderElection = jest.fn().mockResolvedValue(undefined)
const stopLeaderElection = jest.fn()
const isLeaderTab = jest.fn().mockReturnValue(true)
const onLeaderChange = jest.fn().mockReturnValue(() => {})

jest.mock("../tab-lock", () => ({
  startLeaderElection: () => startLeaderElection(),
  stopLeaderElection: () => stopLeaderElection(),
  isLeaderTab: () => isLeaderTab(),
  onLeaderChange: (cb: (v: boolean) => void) => onLeaderChange(cb),
}))

describe("RendererTimingDriver", () => {
  let driver: RendererTimingDriver

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    driver = new RendererTimingDriver()
  })

  afterEach(() => {
    driver.stop()
    jest.useRealTimers()
  })

  it("declares leader-election support", () => {
    expect(driver.supportsLeaderElection).toBe(true)
  })

  it("fires a short-delay arm at the armed instant", () => {
    const due = jest.fn()
    driver.onDue(due)
    const fireAt = Date.now() + 5_000
    driver.arm("task_1", fireAt)
    expect(due).not.toHaveBeenCalled()
    jest.advanceTimersByTime(5_000)
    expect(due).toHaveBeenCalledWith("task_1", fireAt)
  })

  it("fires an overdue arm on the next tick", () => {
    const due = jest.fn()
    driver.onDue(due)
    const fireAt = Date.now() - 1_000
    driver.arm("task_1", fireAt)
    jest.advanceTimersByTime(0)
    expect(due).toHaveBeenCalledWith("task_1", fireAt)
  })

  it("uses drift-resistant polling for long delays and still fires", () => {
    const due = jest.fn()
    driver.onDue(due)
    const fireAt = Date.now() + 130_000 // > 60s threshold
    driver.arm("task_1", fireAt)
    // Poll tick at 60s — not due yet, not yet in the final stretch.
    jest.advanceTimersByTime(60_000)
    expect(due).not.toHaveBeenCalled()
    // Cross into the final-stretch + fire.
    jest.advanceTimersByTime(70_000)
    expect(due).toHaveBeenCalledWith("task_1", fireAt)
  })

  it("does not fire after disarm", () => {
    const due = jest.fn()
    driver.onDue(due)
    driver.arm("task_1", Date.now() + 5_000)
    driver.disarm("task_1")
    jest.advanceTimersByTime(10_000)
    expect(due).not.toHaveBeenCalled()
  })

  it("re-arming replaces the previous timer", () => {
    const due = jest.fn()
    driver.onDue(due)
    driver.arm("task_1", Date.now() + 5_000)
    driver.arm("task_1", Date.now() + 20_000)
    jest.advanceTimersByTime(5_000)
    expect(due).not.toHaveBeenCalled() // original timer was cleared
    jest.advanceTimersByTime(15_000)
    expect(due).toHaveBeenCalledTimes(1)
  })

  it("delegates leader election to tab-lock", async () => {
    await driver.start()
    expect(startLeaderElection).toHaveBeenCalled()
    expect(driver.isLeader()).toBe(true)
    const cb = jest.fn()
    driver.onLeaderChange(cb)
    expect(onLeaderChange).toHaveBeenCalledWith(cb)
    driver.stop()
    expect(stopLeaderElection).toHaveBeenCalled()
  })

  it("start is idempotent", async () => {
    await driver.start()
    await driver.start()
    expect(startLeaderElection).toHaveBeenCalledTimes(1)
  })
})
