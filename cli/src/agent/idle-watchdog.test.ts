/**
 * @jest-environment node
 */
import { createIdleWatchdog, type TimerApi } from "./idle-watchdog"

/**
 * A manual clock + timer pair. `advance(ms)` moves virtual time forward and
 * fires whatever the watchdog scheduled, so every assertion is deterministic.
 */
function fakeTimers() {
  let clock = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: TimerApi = {
    set: (fn, ms) => {
      const id = ++seq
      pending.set(id, { at: clock + ms, fn })
      return id
    },
    clear: (handle) => {
      pending.delete(handle as number)
    },
  }
  return {
    timers,
    now: () => clock,
    /** Move time forward, firing due timers in scheduled order. */
    advance(ms: number) {
      const target = clock + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, timer] = due
        pending.delete(id)
        clock = timer.at
        timer.fn()
      }
      clock = target
    },
    get scheduled() {
      return pending.size
    },
  }
}

/** Resolve to "idle" when the watchdog fires, else "pending" after a microtask drain. */
async function settled(promise: Promise<void>): Promise<"idle" | "pending"> {
  return Promise.race([
    promise.then(() => "idle" as const),
    Promise.resolve().then(() => "pending" as const),
  ])
}

describe("createIdleWatchdog", () => {
  it("does not arm before the first event, so a slow cold start never trips it", async () => {
    const t = fakeTimers()
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    t.advance(10_000)

    expect(t.scheduled).toBe(0)
    await expect(settled(wd.whenIdle())).resolves.toBe("pending")
  })

  it("fires once the stream goes silent past the budget", async () => {
    const t = fakeTimers()
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    wd.bump()
    t.advance(1000)

    await expect(settled(wd.whenIdle())).resolves.toBe("idle")
  })

  it("keeps waiting while events keep arriving", async () => {
    const t = fakeTimers()
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    wd.bump()
    for (let i = 0; i < 5; i++) {
      t.advance(600)
      wd.bump()
    }

    await expect(settled(wd.whenIdle())).resolves.toBe("pending")

    // …and still fires once the deltas actually stop.
    t.advance(1000)
    await expect(settled(wd.whenIdle())).resolves.toBe("idle")
  })

  it("does not rebuild a timer on every event", () => {
    const t = fakeTimers()
    const set = jest.spyOn(t.timers, "set")
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    wd.bump()
    for (let i = 0; i < 10; i++) wd.bump()

    // One arm-time schedule; the pending timer re-schedules itself only when it
    // actually fires early, never per delta.
    expect(set).toHaveBeenCalledTimes(1)
  })

  it("pauses while a permission prompt awaits the user", async () => {
    const t = fakeTimers()
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    wd.bump()
    wd.pause()
    t.advance(60_000) // user deliberates far past the budget

    await expect(settled(wd.whenIdle())).resolves.toBe("pending")

    wd.resume()
    t.advance(999)
    await expect(settled(wd.whenIdle())).resolves.toBe("pending")

    t.advance(1)
    await expect(settled(wd.whenIdle())).resolves.toBe("idle")
  })

  it("stays paused until every nested pause is released", async () => {
    const t = fakeTimers()
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    wd.bump()
    wd.pause()
    wd.pause()
    wd.resume()
    t.advance(10_000)

    await expect(settled(wd.whenIdle())).resolves.toBe("pending")

    wd.resume()
    t.advance(1000)
    await expect(settled(wd.whenIdle())).resolves.toBe("idle")
  })

  it("ignores an unbalanced resume", async () => {
    const t = fakeTimers()
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    wd.bump()
    wd.resume() // never paused
    t.advance(1000)

    await expect(settled(wd.whenIdle())).resolves.toBe("idle")
  })

  it("never fires after stop, and releases the timer", async () => {
    const t = fakeTimers()
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    wd.bump()
    wd.stop()
    t.advance(10_000)

    expect(t.scheduled).toBe(0)
    await expect(settled(wd.whenIdle())).resolves.toBe("pending")
  })

  it("ignores bumps after stop", async () => {
    const t = fakeTimers()
    const wd = createIdleWatchdog({ timeoutMs: 1000, now: t.now, timers: t.timers })

    wd.stop()
    wd.bump()
    t.advance(10_000)

    await expect(settled(wd.whenIdle())).resolves.toBe("pending")
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "is disabled for a %p budget",
    async (timeoutMs) => {
      const t = fakeTimers()
      const wd = createIdleWatchdog({ timeoutMs, now: t.now, timers: t.timers })

      wd.bump()
      wd.pause()
      wd.resume()
      wd.stop()
      t.advance(1_000_000)

      expect(t.scheduled).toBe(0)
      await expect(settled(wd.whenIdle())).resolves.toBe("pending")
    }
  )

  it("uses real timers by default without holding the process open", async () => {
    const wd = createIdleWatchdog({ timeoutMs: 1 })
    wd.bump()
    await expect(wd.whenIdle()).resolves.toBeUndefined()
  })
})
