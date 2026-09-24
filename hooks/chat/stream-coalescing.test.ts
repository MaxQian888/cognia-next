import type { UIMessage } from "ai"
import {
  createRafThrottle,
  createDebouncedCallback,
  SessionCoalescingRegistry,
} from "./stream-coalescing"

const msg = (id: string): UIMessage =>
  ({ id, role: "assistant", parts: [] }) as unknown as UIMessage

describe("createRafThrottle", () => {
  let rafQueue: FrameRequestCallback[]
  let realRaf: typeof requestAnimationFrame
  let realCancel: typeof cancelAnimationFrame

  beforeEach(() => {
    rafQueue = []
    realRaf = global.requestAnimationFrame
    realCancel = global.cancelAnimationFrame
    global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length // 1-based id
    }) as typeof requestAnimationFrame
    global.cancelAnimationFrame = ((id: number) => {
      rafQueue[id - 1] = (() => {}) as FrameRequestCallback
    }) as typeof cancelAnimationFrame
  })
  afterEach(() => {
    global.requestAnimationFrame = realRaf
    global.cancelAnimationFrame = realCancel
  })
  const drainFrame = () => {
    const q = rafQueue
    rafQueue = []
    for (const cb of q) cb(0)
  }

  it("coalesces multiple calls in a frame to the latest args", () => {
    const fn = jest.fn()
    const h = createRafThrottle<[UIMessage[]]>(fn)
    h.call([msg("a")])
    h.call([msg("b")])
    expect(fn).not.toHaveBeenCalled()
    drainFrame()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith([msg("b")])
  })

  it("flush() invokes immediately with latest args and cancels the frame", () => {
    const fn = jest.fn()
    const h = createRafThrottle<[UIMessage[]]>(fn)
    h.call([msg("a")])
    h.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    drainFrame() // canceled frame is a no-op
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("flush() with nothing pending is a no-op", () => {
    const fn = jest.fn()
    createRafThrottle<[UIMessage[]]>(fn).flush()
    expect(fn).not.toHaveBeenCalled()
  })

  it("cancel() discards pending args", () => {
    const fn = jest.fn()
    const h = createRafThrottle<[UIMessage[]]>(fn)
    h.call([msg("a")])
    h.cancel()
    drainFrame()
    expect(fn).not.toHaveBeenCalled()
  })

  it("degrades to synchronous when rAF is unavailable", () => {
    const saved = global.requestAnimationFrame
    // @ts-expect-error force-undefined for the degradation branch
    global.requestAnimationFrame = undefined
    const fn = jest.fn()
    const h = createRafThrottle<[UIMessage[]]>(fn)
    h.call([msg("a")])
    expect(fn).toHaveBeenCalledWith([msg("a")])
    global.requestAnimationFrame = saved
  })
})

describe("createDebouncedCallback", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("fires once after the window with the latest args", () => {
    const fn = jest.fn()
    const h = createDebouncedCallback<[UIMessage[]]>(fn, 100)
    h.call([msg("a")])
    h.call([msg("b")])
    expect(fn).not.toHaveBeenCalled()
    jest.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith([msg("b")])
  })

  it("delay <= 0 degrades to synchronous", () => {
    const fn = jest.fn()
    const h = createDebouncedCallback<[UIMessage[]]>(fn, 0)
    h.call([msg("a")])
    expect(fn).toHaveBeenCalledWith([msg("a")])
  })

  it("flush() fires immediately and cancel() discards", () => {
    const fn = jest.fn()
    const h = createDebouncedCallback<[UIMessage[]]>(fn, 100)
    h.call([msg("a")])
    h.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    h.call([msg("b")])
    h.cancel()
    jest.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    // flush with nothing pending is a no-op
    h.flush()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("bounds continuous calls while ordinary debounce remains trailing-only", () => {
    const bounded = jest.fn()
    const trailing = jest.fn()
    const checkpoint = createDebouncedCallback<[number]>(bounded, 250, 1000)
    const ordinary = createDebouncedCallback<[number]>(trailing, 250)
    for (let token = 0; token < 200; token++) {
      checkpoint.call(token)
      ordinary.call(token)
      jest.advanceTimersByTime(10)
    }
    expect(bounded.mock.calls).toEqual([[99], [199]])
    expect(trailing).not.toHaveBeenCalled()
    jest.advanceTimersByTime(250)
    expect(bounded).toHaveBeenCalledTimes(2)
    expect(trailing).toHaveBeenCalledWith(199)
  })

  it("flush and cancel clear both timers, allowing a fresh checkpoint window", () => {
    const fn = jest.fn()
    const h = createDebouncedCallback<[number]>(fn, 250, 1000)
    h.call(1)
    h.flush()
    h.flush()
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(1000)
    expect(fn.mock.calls).toEqual([[1]])
    h.call(2)
    h.cancel()
    expect(jest.getTimerCount()).toBe(0)
    h.flush()
    jest.advanceTimersByTime(1000)
    expect(fn.mock.calls).toEqual([[1]])
    h.call(3)
    jest.advanceTimersByTime(250)
    expect(fn.mock.calls).toEqual([[1], [3]])
    expect(jest.getTimerCount()).toBe(0)
  })

  it("zero delay stays synchronous with max wait and leaves no timers", () => {
    const fn = jest.fn()
    const h = createDebouncedCallback<[number]>(fn, 0, 1000)
    h.call(1)
    h.call(2)
    h.flush()
    expect(fn.mock.calls).toEqual([[1], [2]])
    expect(jest.getTimerCount()).toBe(0)
  })

  it("honors a maximum wait shorter than the trailing window", () => {
    const fn = jest.fn()
    const h = createDebouncedCallback<[number]>(fn, 2000, 1000)
    h.call(1)
    jest.advanceTimersByTime(1000)
    expect(fn.mock.calls).toEqual([[1]])
    expect(jest.getTimerCount()).toBe(0)
  })

  it("retains a new call scheduled from inside the callback", () => {
    const fn = jest.fn((value: number) => {
      if (value === 1) h.call(2)
    })
    const h = createDebouncedCallback<[number]>(fn, 250, 1000)
    h.call(1)
    h.flush()
    jest.advanceTimersByTime(250)
    expect(fn.mock.calls).toEqual([[1], [2]])
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe("SessionCoalescingRegistry", () => {
  it("creates one stable pair per session and routes by id", () => {
    const onCommit = jest.fn()
    const onPersist = jest.fn()
    const reg = new SessionCoalescingRegistry({ onCommit, onPersist, persistDelayMs: 0 })
    const a = reg.get("A")
    expect(reg.get("A")).toBe(a) // stable
    const b = reg.get("B")
    expect(b).not.toBe(a)

    a.commit.call([msg("a1")])
    a.commit.flush()
    b.commit.call([msg("b1")])
    b.commit.flush()
    expect(onCommit).toHaveBeenCalledWith("A", [msg("a1")])
    expect(onCommit).toHaveBeenCalledWith("B", [msg("b1")])

    // persistDelayMs 0 → synchronous
    a.persist.call([msg("a1")])
    expect(onPersist).toHaveBeenCalledWith("A", [msg("a1")])
  })

  it("release(id) cancels pending work and forgets the session", () => {
    const onPersist = jest.fn()
    jest.useFakeTimers()
    const reg = new SessionCoalescingRegistry({
      onCommit: jest.fn(),
      onPersist,
      persistDelayMs: 100,
    })
    const a = reg.get("A")
    a.persist.call([msg("a1")])
    reg.release("A")
    jest.advanceTimersByTime(100)
    expect(onPersist).not.toHaveBeenCalled()
    // A fresh get after release returns a new pair.
    expect(reg.get("A")).not.toBe(a)
    jest.useRealTimers()
  })

  it("flushAllPersist flushes every session; clear cancels everything", () => {
    const onPersist = jest.fn()
    jest.useFakeTimers()
    const reg = new SessionCoalescingRegistry({
      onCommit: jest.fn(),
      onPersist,
      persistDelayMs: 100,
    })
    reg.get("A").persist.call([msg("a1")])
    reg.get("B").persist.call([msg("b1")])
    reg.flushAllPersist()
    expect(onPersist).toHaveBeenCalledTimes(2)

    // After clear, pending timers don't fire.
    reg.get("C").persist.call([msg("c1")])
    reg.clear()
    jest.advanceTimersByTime(100)
    expect(onPersist).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it("release on an unknown id is a no-op", () => {
    const reg = new SessionCoalescingRegistry({
      onCommit: jest.fn(),
      onPersist: jest.fn(),
      persistDelayMs: 0,
    })
    expect(() => reg.release("nope")).not.toThrow()
  })
})

/**
 * ADR-0127 §5 acceptance, deterministic half: at a synthetic 100 tok/s stream
 * the registry must produce ≤ 1 store commit per animation frame and request
 * checkpoints at least once per second during continuous deltas. Callback
 * counts measure scheduling, not completed Dexie transactions. This backs the
 * timing bars measured by the opt-in `@perf` Playwright suite.
 */
describe("ADR-0127 streaming budget (100 tok/s)", () => {
  let rafQueue: FrameRequestCallback[]
  let realRaf: typeof requestAnimationFrame
  let realCancel: typeof cancelAnimationFrame

  beforeEach(() => {
    jest.useFakeTimers()
    rafQueue = []
    realRaf = global.requestAnimationFrame
    realCancel = global.cancelAnimationFrame
    global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    }) as typeof requestAnimationFrame
    global.cancelAnimationFrame = ((id: number) => {
      rafQueue[id - 1] = (() => {}) as FrameRequestCallback
    }) as typeof cancelAnimationFrame
  })
  afterEach(() => {
    jest.useRealTimers()
    global.requestAnimationFrame = realRaf
    global.cancelAnimationFrame = realCancel
  })

  it("commits at most once per frame and persists at most once per 250 ms window", () => {
    const onCommit = jest.fn()
    const onPersist = jest.fn()
    const registry = new SessionCoalescingRegistry({ onCommit, onPersist, persistDelayMs: 250 })
    const pair = registry.get("s1")

    // 60 frames at 16 ms, 100 tokens/s ⇒ ~1.6 deltas per frame ⇒ 96 deltas.
    const FRAMES = 60
    const TOKENS = 96
    let delivered = 0
    let framesDrained = 0
    for (let frame = 0; frame < FRAMES; frame++) {
      const target = Math.floor(((frame + 1) * TOKENS) / FRAMES)
      while (delivered < target) {
        delivered++
        const list = [msg(`t${delivered}`)]
        pair.commit.call(list)
        pair.persist.call(list)
      }
      // End of frame: drain rAF callbacks, advance the wall clock 16 ms.
      const q = rafQueue
      rafQueue = []
      for (const cb of q) cb(0)
      framesDrained++
      jest.advanceTimersByTime(16)
    }
    expect(delivered).toBe(TOKENS)
    // ≤ 1 React commit per frame (and at least one — the stream is live).
    expect(onCommit.mock.calls.length).toBeLessThanOrEqual(framesDrained)
    expect(onCommit.mock.calls.length).toBeGreaterThan(0)
    // The 960 ms burst is shorter than the checkpoint deadline. Its latest
    // snapshot is submitted by the one-second deadline after streaming stops.
    expect(onPersist).not.toHaveBeenCalled()
    jest.advanceTimersByTime(250)
    expect(onPersist).toHaveBeenCalledTimes(1)
    expect(onPersist).toHaveBeenLastCalledWith("s1", [msg(`t${TOKENS}`)])
    registry.release("s1")
  })

  it("checkpoints a simulated hour at 100 tok/s with at most 1000 ms of pending updates", () => {
    jest.setSystemTime(0)
    let latestSubmittedAt = 0
    let maxPendingMs = 0
    let submissions = 0
    let lastToken = ""
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist: (_sessionId, messages) => {
        submissions++
        lastToken = messages[0].id
        maxPendingMs = Math.max(maxPendingMs, Date.now() - latestSubmittedAt)
        latestSubmittedAt = Date.now()
      },
      persistDelayMs: 250,
    })
    const persist = registry.get("hour-long").persist
    for (let token = 0; token < 360_000; token++) {
      persist.call([msg(String(token))])
      jest.advanceTimersByTime(10)
    }
    maxPendingMs = Math.max(maxPendingMs, Date.now() - latestSubmittedAt)
    expect({ submissions, maxPendingMs, lastToken }).toEqual({
      submissions: 3600,
      maxPendingMs: 1000,
      lastToken: "359999",
    })
    registry.flushAllPersist()
    registry.clear()
    expect(submissions).toBe(3600)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("keeps independently offset checkpoint deadlines and cancels released sessions", () => {
    const onPersist = jest.fn()
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist,
      persistDelayMs: 250,
      persistMaxWaitMs: 500,
    })
    for (let tick = 0; tick < 10; tick++) {
      registry.get("A").persist.call([msg(`a${tick}`)])
      if (tick >= 2) registry.get("B").persist.call([msg(`b${tick}`)])
      jest.advanceTimersByTime(50)
    }
    expect(onPersist.mock.calls).toEqual([["A", [msg("a9")]]])
    registry.get("B").persist.call([msg("b10")])
    jest.advanceTimersByTime(100)
    expect(onPersist.mock.calls).toEqual([
      ["A", [msg("a9")]],
      ["B", [msg("b10")]],
    ])
    registry.get("C").persist.call([msg("c1")])
    registry.release("C")
    jest.advanceTimersByTime(1000)
    expect(onPersist).toHaveBeenCalledTimes(2)
    registry.clear()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("keeps sessions independent: N concurrent streams ⇒ N commits per frame, not N×tokens", () => {
    const onCommit = jest.fn()
    const registry = new SessionCoalescingRegistry({
      onCommit,
      onPersist: () => {},
      persistDelayMs: 250,
    })
    for (let i = 0; i < 4; i++) {
      const pair = registry.get(`s${i}`)
      for (let t = 0; t < 25; t++) pair.commit.call([msg(`s${i}-${t}`)])
    }
    const q = rafQueue
    rafQueue = []
    for (const cb of q) cb(0)
    expect(onCommit).toHaveBeenCalledTimes(4)
    registry.clear()
  })
})
