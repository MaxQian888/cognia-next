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
