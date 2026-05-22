/**
 * @jest-environment jsdom
 */

import { TerminalBackpressure, type TermLike } from "./backpressure"

interface FakeTerm extends TermLike {
  writes: Uint8Array[]
  acks: Array<() => void>
}

function fakeTerm(): FakeTerm {
  const writes: Uint8Array[] = []
  const acks: Array<() => void> = []
  return {
    writes,
    acks,
    write(data, cb) {
      writes.push(data)
      if (cb) acks.push(cb)
    },
  }
}

/**
 * Deferred scheduler — captures the flush callback so tests can drive
 * the flush boundary explicitly. Returns both the scheduler and a
 * `drain()` helper that fires the most-recently-deferred callback.
 */
function deferredScheduler() {
  let pending: (() => void) | null = null
  const schedule = (cb: () => void) => {
    pending = cb
  }
  const drain = () => {
    const cb = pending
    pending = null
    cb?.()
  }
  return { schedule, drain }
}

describe("TerminalBackpressure", () => {
  it("merges multiple chunks into a single write per flush", () => {
    const term = fakeTerm()
    const { schedule, drain } = deferredScheduler()
    const bp = new TerminalBackpressure({ term, scheduler: schedule })
    bp.push(new Uint8Array([1, 2]))
    bp.push(new Uint8Array([3, 4]))
    bp.push(new Uint8Array([5]))
    // Nothing written until the rAF tick fires.
    expect(term.writes).toHaveLength(0)
    drain()
    expect(term.writes).toHaveLength(1)
    expect(Array.from(term.writes[0]!)).toEqual([1, 2, 3, 4, 5])
    void bp
  })

  it("ignores empty chunks", () => {
    const term = fakeTerm()
    const { schedule, drain } = deferredScheduler()
    const bp = new TerminalBackpressure({ term, scheduler: schedule })
    bp.push(new Uint8Array([]))
    drain()
    expect(term.writes).toHaveLength(0)
    void bp
  })

  it("does NOT pause when pending + unacked stays below the high watermark", () => {
    const term = fakeTerm()
    const onPause = jest.fn()
    const { schedule, drain } = deferredScheduler()
    const bp = new TerminalBackpressure({
      term,
      onPause,
      scheduler: schedule,
      highWatermark: 100,
      lowWatermark: 50,
    })
    bp.push(new Uint8Array(50))
    expect(onPause).not.toHaveBeenCalled()
    expect(bp.isPaused).toBe(false)
    drain()
  })

  it("triggers onPause once when pending crosses the high watermark", () => {
    const term = fakeTerm()
    const onPause = jest.fn()
    const { schedule, drain } = deferredScheduler()
    const bp = new TerminalBackpressure({
      term,
      onPause,
      scheduler: schedule,
      highWatermark: 100,
      lowWatermark: 50,
    })
    bp.push(new Uint8Array(60))
    bp.push(new Uint8Array(50)) // pending=110 > 100 → pause
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(bp.isPaused).toBe(true)
    // Subsequent pushes don't re-pause.
    bp.push(new Uint8Array(5))
    expect(onPause).toHaveBeenCalledTimes(1)
    drain()
  })

  it("triggers onResume after acks drain below the low watermark", () => {
    const term = fakeTerm()
    const onResume = jest.fn()
    const { schedule, drain } = deferredScheduler()
    const bp = new TerminalBackpressure({
      term,
      onResume,
      scheduler: schedule,
      highWatermark: 100,
      lowWatermark: 50,
    })
    bp.push(new Uint8Array(60))
    bp.push(new Uint8Array(50)) // pending=110 — paused
    expect(bp.isPaused).toBe(true)
    drain() // single 110-byte write
    expect(term.writes).toHaveLength(1)
    expect(term.acks).toHaveLength(1)
    // Ack the 110-byte write → unacked = 0, below 50 LWM → resume fires.
    term.acks.shift()?.()
    expect(bp.isPaused).toBe(false)
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it("does not crash when ack fires after dispose", () => {
    const term = fakeTerm()
    const { schedule, drain } = deferredScheduler()
    const bp = new TerminalBackpressure({ term, scheduler: schedule })
    bp.push(new Uint8Array([1, 2, 3]))
    drain()
    bp.dispose()
    expect(() => term.acks.shift()?.()).not.toThrow()
  })

  it("flushNow drains pending immediately", () => {
    const term = fakeTerm()
    let deferred: (() => void) | null = null
    const bp = new TerminalBackpressure({
      term,
      scheduler: (cb) => {
        deferred = cb
      },
    })
    bp.push(new Uint8Array([1, 2]))
    expect(term.writes).toHaveLength(0)
    bp.flushNow()
    expect(term.writes).toHaveLength(1)
    // The scheduled flush still resolves, but pending is empty so it no-ops.
    deferred?.()
    expect(term.writes).toHaveLength(1)
  })

  it("dispose drops pending without writing", () => {
    const term = fakeTerm()
    let deferred: (() => void) | null = null
    const bp = new TerminalBackpressure({
      term,
      scheduler: (cb) => {
        deferred = cb
      },
    })
    bp.push(new Uint8Array([1, 2]))
    bp.dispose()
    deferred?.()
    expect(term.writes).toHaveLength(0)
  })

  it("reports inFlightBytes as pending + unacked", () => {
    const term = fakeTerm()
    let deferred: (() => void) | null = null
    const bp = new TerminalBackpressure({
      term,
      scheduler: (cb) => {
        deferred = cb
      },
    })
    bp.push(new Uint8Array(10))
    expect(bp.inFlightBytes).toBe(10)
    deferred?.()
    expect(bp.inFlightBytes).toBe(10) // moved to unacked
    term.acks.shift()?.()
    expect(bp.inFlightBytes).toBe(0)
  })
})
