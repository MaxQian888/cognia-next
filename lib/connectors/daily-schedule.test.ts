/**
 * Tests for the generic daily-housekeeping scheduler.
 *
 * A fake scheduler captures the registered timeout/interval callbacks so we
 * can drive them deterministically without real timers.
 */

import { startDailySchedule, DAILY_INTERVAL_MS, DAILY_INITIAL_DELAY_MS } from "./daily-schedule"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeScheduler() {
  const timeouts: Array<{ cb: () => void; ms: number }> = []
  const intervals: Array<{ cb: () => void; ms: number }> = []
  const clearedTimeouts: unknown[] = []
  const clearedIntervals: unknown[] = []
  return {
    timeouts,
    intervals,
    clearedTimeouts,
    clearedIntervals,
    scheduler: {
      setTimeout: (cb: () => void, ms: number) => {
        timeouts.push({ cb, ms })
        return timeouts.length - 1
      },
      clearTimeout: (h: unknown) => clearedTimeouts.push(h),
      setInterval: (cb: () => void, ms: number) => {
        intervals.push({ cb, ms })
        return intervals.length - 1
      },
      clearInterval: (h: unknown) => clearedIntervals.push(h),
    },
  }
}

describe("startDailySchedule", () => {
  it("runs the task after the initial delay, then on each interval", async () => {
    const s = makeScheduler()
    const task = jest.fn().mockResolvedValue(undefined)

    startDailySchedule({ task, label: "test", scheduler: s.scheduler })

    // Nothing runs until the initial timeout fires.
    expect(s.timeouts).toHaveLength(1)
    expect(s.timeouts[0].ms).toBe(DAILY_INITIAL_DELAY_MS)
    expect(task).not.toHaveBeenCalled()

    // Fire initial timeout → first sweep + interval registration.
    s.timeouts[0].cb()
    await flush()
    expect(task).toHaveBeenCalledTimes(1)
    expect(s.intervals).toHaveLength(1)
    expect(s.intervals[0].ms).toBe(DAILY_INTERVAL_MS)

    // Fire interval twice → two more sweeps.
    s.intervals[0].cb()
    await flush()
    s.intervals[0].cb()
    await flush()
    expect(task).toHaveBeenCalledTimes(3)
  })

  it("honours custom interval + initial delay", () => {
    const s = makeScheduler()
    startDailySchedule({
      task: jest.fn().mockResolvedValue(undefined),
      label: "test",
      intervalMs: 5,
      initialDelayMs: 1,
      scheduler: s.scheduler,
    })
    expect(s.timeouts[0].ms).toBe(1)
    s.timeouts[0].cb()
    expect(s.intervals[0].ms).toBe(5)
  })

  it("dispose stops the timers and prevents further runs", async () => {
    const s = makeScheduler()
    const task = jest.fn().mockResolvedValue(undefined)
    const handle = startDailySchedule({ task, label: "test", scheduler: s.scheduler })

    s.timeouts[0].cb()
    await flush()
    expect(task).toHaveBeenCalledTimes(1)

    handle.dispose()
    expect(s.clearedTimeouts).toHaveLength(1)
    expect(s.clearedIntervals).toHaveLength(1)

    // A stale interval tick after dispose is a no-op.
    s.intervals[0].cb()
    await flush()
    expect(task).toHaveBeenCalledTimes(1)

    // dispose is idempotent.
    handle.dispose()
    expect(s.clearedTimeouts).toHaveLength(1)
  })

  it("runNow triggers an immediate sweep", async () => {
    const s = makeScheduler()
    const task = jest.fn().mockResolvedValue(undefined)
    const handle = startDailySchedule({ task, label: "test", scheduler: s.scheduler })

    await handle.runNow()
    expect(task).toHaveBeenCalledTimes(1)
  })

  it("swallows + logs a task error so the schedule survives", async () => {
    const s = makeScheduler()
    const task = jest.fn().mockRejectedValue(new Error("boom"))
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})

    const handle = startDailySchedule({ task, label: "test-label", scheduler: s.scheduler })
    await handle.runNow()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[test-label]"))
    errorSpy.mockRestore()
  })
})
