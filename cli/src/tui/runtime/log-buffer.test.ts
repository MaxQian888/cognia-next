import { createLogCoalescer, type LogTimers } from "./log-buffer"
import { LOG_MESSAGE_CLAMP } from "./log-model"
import type { LogInput } from "../state/types"

/** Deterministic timer double — no globals, so this runs in the fast node project. */
function fakeTimers() {
  let next = 1
  const jobs = new Map<number, { cb: () => void; at: number }>()
  let now = 0
  const timers: LogTimers = {
    set: (cb, ms) => {
      const id = next++
      jobs.set(id, { cb, at: now + ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clear: (h) => {
      jobs.delete(h as unknown as number)
    },
  }
  const advance = (ms: number) => {
    now += ms
    for (const [id, job] of [...jobs]) {
      if (job.at <= now) {
        jobs.delete(id)
        job.cb()
      }
    }
  }
  return { timers, advance, pendingJobs: () => jobs.size }
}

const line = (message: string): LogInput => ({
  ts: 1,
  level: "info",
  channel: "agent",
  message,
})

describe("createLogCoalescer", () => {
  it("collapses a burst into ONE flush carrying every entry", () => {
    const { timers, advance } = fakeTimers()
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, timers, intervalMs: 80 })

    for (let i = 0; i < 200; i++) c.push(line(`m${i}`))
    expect(flush).not.toHaveBeenCalled() // nothing dispatched mid-burst

    advance(80)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0][0]).toHaveLength(200)
  })

  it("keeps flushing on schedule under a CONTINUOUS stream (not a debounce)", () => {
    const { timers, advance } = fakeTimers()
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, timers, intervalMs: 80 })

    // A debounce would re-arm on every push and never fire while input keeps
    // arriving — this is the regression guard for that.
    for (let tick = 0; tick < 5; tick++) {
      c.push(line(`t${tick}`))
      advance(40)
      c.push(line(`t${tick}b`))
      advance(40)
    }
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it("flushes synchronously once pending crosses maxPending", () => {
    const { timers } = fakeTimers()
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, timers, intervalMs: 80, maxPending: 10 })

    for (let i = 0; i < 10; i++) c.push(line(`m${i}`))
    expect(flush).toHaveBeenCalledTimes(1) // no timer advance needed
    expect(flush.mock.calls[0][0]).toHaveLength(10)
  })

  it("does not dispatch on an empty window", () => {
    const { timers, advance } = fakeTimers()
    const flush = jest.fn()
    createLogCoalescer({ flush, timers, intervalMs: 80 })
    advance(200)
    expect(flush).not.toHaveBeenCalled()
  })

  it("clamps over-long messages at push time", () => {
    const { timers, advance } = fakeTimers()
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, timers })
    c.push(line("x".repeat(LOG_MESSAGE_CLAMP + 50)))
    advance(80)
    expect(flush.mock.calls[0][0][0].message).toContain("…[+50 chars]")
  })

  it("honours a custom clamp width", () => {
    const { timers, advance } = fakeTimers()
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, timers, clampChars: 5 })
    c.push(line("abcdefgh"))
    advance(80)
    expect(flush.mock.calls[0][0][0].message).toBe("abcde …[+3 chars]")
  })

  it("flushNow drains immediately and disarms the timer", () => {
    const { timers, advance, pendingJobs } = fakeTimers()
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, timers })
    c.push(line("a"))
    c.flushNow()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(pendingJobs()).toBe(0)
    advance(200)
    expect(flush).toHaveBeenCalledTimes(1) // no second, empty flush
  })

  it("discardPending drops in-flight lines without dispatching", () => {
    const { timers, advance } = fakeTimers()
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, timers })
    c.push(line("a"))
    c.discardPending()
    advance(200)
    // Without this, lines already queued would land right after a clear and the
    // panel would look like it failed to clear.
    expect(flush).not.toHaveBeenCalled()
  })

  it("dispose stops the timer, drops pending, and makes later pushes no-ops", () => {
    const { timers, advance, pendingJobs } = fakeTimers()
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, timers })
    c.push(line("a"))
    c.dispose()
    expect(pendingJobs()).toBe(0)
    c.push(line("b"))
    advance(200)
    expect(flush).not.toHaveBeenCalled()
  })

  it("is safe to dispose twice", () => {
    const { timers } = fakeTimers()
    const c = createLogCoalescer({ flush: jest.fn(), timers })
    c.dispose()
    expect(() => c.dispose()).not.toThrow()
  })

  it("defaults to the real timers when none are injected", async () => {
    const flush = jest.fn()
    const c = createLogCoalescer({ flush, intervalMs: 1 })
    c.push(line("a"))
    await new Promise((r) => setTimeout(r, 20))
    expect(flush).toHaveBeenCalledTimes(1)
    c.dispose()
  })
})
