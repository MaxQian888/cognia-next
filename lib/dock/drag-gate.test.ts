import { createDockDragGate, type DockDragSettleReason } from "./drag-gate"

/** Deterministic stand-in for setTimeout so no test waits on real time. */
function createClock() {
  let nextHandle = 1
  const timers = new Map<number, { fn: () => void; due: number }>()
  let now = 0
  return {
    schedule: (fn: () => void, ms: number) => {
      const handle = nextHandle++
      timers.set(handle, { fn, due: now + ms })
      return handle
    },
    cancel: (handle: number) => {
      timers.delete(handle)
    },
    advance: (ms: number) => {
      now += ms
      for (const [handle, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(handle)
          timer.fn()
        }
      }
    },
    pending: () => timers.size,
  }
}

function setup(quietMs = 100) {
  const clock = createClock()
  const settled: DockDragSettleReason[] = []
  const gate = createDockDragGate({
    onSettled: (reason) => settled.push(reason),
    quietMs,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  return { clock, settled, gate }
}

describe("createDockDragGate", () => {
  it("writes nothing during a gesture and exactly once when it ends", () => {
    // The contract the whole gate exists for: a drag emits dozens of
    // intermediate layouts, none of which the user asked to persist.
    const { clock, settled, gate } = setup()
    gate.beginGesture()
    for (let i = 0; i < 40; i += 1) gate.notifyLayoutChange()
    clock.advance(1000)
    expect(settled).toEqual([])

    gate.endGesture()
    expect(settled).toEqual(["gesture-end"])
  })

  it("does not settle a gesture that changed nothing", () => {
    const { settled, gate } = setup()
    gate.beginGesture()
    gate.endGesture()
    expect(settled).toEqual([])
  })

  it("coalesces an ungated burst into one settled change after the quiet period", () => {
    // dockview reports a splitter drag as a burst with no begin/end signal.
    const { clock, settled, gate } = setup(100)
    gate.notifyLayoutChange()
    clock.advance(50)
    gate.notifyLayoutChange()
    clock.advance(50)
    gate.notifyLayoutChange()
    expect(settled).toEqual([])

    clock.advance(100)
    expect(settled).toEqual(["quiet"])
  })

  it("folds a burst that was still quieting into the gesture that interrupted it", () => {
    const { clock, settled, gate } = setup(100)
    gate.notifyLayoutChange()
    clock.advance(50)

    gate.beginGesture()
    clock.advance(1000)
    expect(settled).toEqual([])

    gate.notifyLayoutChange()
    gate.endGesture()
    expect(settled).toEqual(["gesture-end"])
  })

  it("reports whether a gesture is in flight", () => {
    const { gate } = setup()
    expect(gate.isDragging()).toBe(false)
    gate.beginGesture()
    expect(gate.isDragging()).toBe(true)
    gate.endGesture()
    expect(gate.isDragging()).toBe(false)
  })

  it("ignores an end without a begin", () => {
    const { settled, gate } = setup()
    gate.endGesture()
    expect(settled).toEqual([])
  })

  it("stops flushing after dispose so a commit cannot outlive its host", () => {
    const { clock, settled, gate } = setup(100)
    gate.notifyLayoutChange()
    gate.dispose()
    clock.advance(1000)
    expect(settled).toEqual([])
    expect(clock.pending()).toBe(0)

    // Every entry point is inert afterwards.
    gate.beginGesture()
    gate.notifyLayoutChange()
    gate.endGesture()
    clock.advance(1000)
    expect(settled).toEqual([])
    expect(gate.isDragging()).toBe(false)
  })

  it("suppresses a quiet flush that fires after dispose", () => {
    // The timer may already be in flight when the host unmounts.
    const settled: DockDragSettleReason[] = []
    let queued: (() => void) | null = null
    const gate = createDockDragGate({
      onSettled: (reason) => settled.push(reason),
      quietMs: 10,
      schedule: (fn) => {
        queued = fn
        return 1
      },
      cancel: () => {
        // Deliberately does not clear `queued` — simulates a timer that already
        // escaped cancellation.
      },
    })
    gate.notifyLayoutChange()
    gate.dispose()
    queued!()
    expect(settled).toEqual([])
  })

  it("falls back to real timers when none are injected", () => {
    jest.useFakeTimers()
    try {
      const settled: DockDragSettleReason[] = []
      // No `quietMs` either — exercises the default quiet period.
      const gate = createDockDragGate({ onSettled: (r) => settled.push(r) })
      gate.notifyLayoutChange()
      jest.advanceTimersByTime(200)
      expect(settled).toEqual(["quiet"])

      // A pending timer at dispose exercises the default `cancel`.
      gate.notifyLayoutChange()
      gate.dispose()
      jest.advanceTimersByTime(500)
      expect(settled).toEqual(["quiet"])
    } finally {
      jest.useRealTimers()
    }
  })
})
