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
 * the registry must produce ≤ 1 store commit per animation frame and ≤ 1 Dexie
 * write per 250 ms debounce window. This is the Jest gate that backs the
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
    // Trailing debounce: while deltas keep arriving faster than 250 ms apart,
    // the writer never fires; it fires once after the stream goes quiet.
    expect(onPersist).not.toHaveBeenCalled()
    jest.advanceTimersByTime(250)
    expect(onPersist).toHaveBeenCalledTimes(1)
    expect(onPersist).toHaveBeenLastCalledWith("s1", [msg(`t${TOKENS}`)])
    registry.release("s1")
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
