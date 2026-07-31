import { act, renderHook } from "@testing-library/react"
import { usePetWidgetThrow, type PetWidgetThrowIo } from "./use-pet-widget-throw"

/** Deterministic clock + manual rAF queue standing in for the browser. */
function makeIo() {
  let now = 0
  let nextId = 1
  const rafs = new Map<number, () => void>()
  const io: PetWidgetThrowIo = {
    now: () => now,
    raf: (cb) => {
      const id = nextId++
      rafs.set(id, cb)
      return id
    },
    caf: (id) => void rafs.delete(id),
  }
  /** Run every queued rAF once (each frame may queue the next), advancing the clock. */
  const flushRaf = (dtMs = 16) => {
    now += dtMs
    const pending = [...rafs.values()]
    rafs.clear()
    for (const cb of pending) cb()
  }
  /** Keep flushing until no more frames are queued (a throw settling). */
  const runToSettle = (maxFrames = 500, dtMs = 16) => {
    for (let i = 0; i < maxFrames && rafs.size > 0; i++) flushRaf(dtMs)
  }
  return { io, flushRaf, runToSettle, rafCount: () => rafs.size }
}

/** Fake anchor element with a controllable, untransformed bounding rect. */
function makeAnchorRef(rect: { left: number; top: number }) {
  const el = {
    getBoundingClientRect: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left,
      bottom: rect.top,
      width: 0,
      height: 0,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement
  return { current: el }
}

const VIEWPORT = { width: 1200, height: 800 }

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VIEWPORT.height })
})

describe("usePetWidgetThrow", () => {
  it("starts at (0,0) by default and honors a restored initial offset", () => {
    const { result: a } = renderHook(() =>
      usePetWidgetThrow({ anchorRef: makeAnchorRef({ left: 0, top: 0 }), petSize: 96 })
    )
    expect(a.current.offset).toEqual({ x: 0, y: 0 })

    const { result: b } = renderHook(() =>
      usePetWidgetThrow({
        anchorRef: makeAnchorRef({ left: 0, top: 0 }),
        petSize: 96,
        initialOffset: { x: 12, y: -4 },
      })
    )
    expect(b.current.offset).toEqual({ x: 12, y: -4 })
  })

  it("beginThrow is a no-op without a resolved anchor rect", () => {
    const io = makeIo()
    const anchorRef = { current: null }
    const { result } = renderHook(() => usePetWidgetThrow({ anchorRef, petSize: 96, io: io.io }))
    act(() => result.current.beginThrow(500, -500))
    expect(result.current.isThrowing).toBe(false)
    expect(io.rafCount()).toBe(0)
  })

  it("a top-anchored throw falls under gravity and settles, calling onSettle", () => {
    const io = makeIo()
    const onSettle = jest.fn()
    // Anchored near the top → plenty of room to fall toward the viewport bottom.
    const anchorRef = makeAnchorRef({ left: 100, top: 20 })
    const { result } = renderHook(() =>
      usePetWidgetThrow({ anchorRef, petSize: 96, onSettle, io: io.io })
    )
    act(() => result.current.beginThrow(0, -200))
    expect(result.current.isThrowing).toBe(true)
    act(() => io.runToSettle())
    expect(result.current.isThrowing).toBe(false)
    expect(onSettle).toHaveBeenCalledTimes(1)
    const [x, y] = onSettle.mock.calls[0] as [number, number]
    // Settled offset.y should land at the resolved ground (viewport bottom - anchor top - size).
    expect(y).toBe(VIEWPORT.height - 20 - 96)
    expect(typeof x).toBe("number")
  })

  it("a bottom-anchored throw has almost no room to fall (small groundY)", () => {
    const io = makeIo()
    const onSettle = jest.fn()
    // Anchored right at the viewport bottom edge minus the pet size → groundY ~ 0.
    const anchorRef = makeAnchorRef({ left: 50, top: VIEWPORT.height - 96 })
    const { result } = renderHook(() =>
      usePetWidgetThrow({ anchorRef, petSize: 96, onSettle, io: io.io })
    )
    act(() => result.current.beginThrow(0, 50))
    act(() => io.runToSettle())
    const [, y] = onSettle.mock.calls[0] as [number, number]
    expect(y).toBe(0)
  })

  it("wall-bounces horizontally within the on-screen bounds", () => {
    const io = makeIo()
    const onSettle = jest.fn()
    const anchorRef = makeAnchorRef({ left: 20, top: 20 })
    const { result } = renderHook(() =>
      usePetWidgetThrow({ anchorRef, petSize: 96, onSettle, io: io.io })
    )
    // A hard rightward fling — maxX = viewport.width - left - size = 1200-20-96 = 1084.
    act(() => result.current.beginThrow(5000, 0))
    act(() => io.runToSettle())
    const [x] = onSettle.mock.calls[0] as [number, number]
    expect(x).toBeLessThanOrEqual(1200 - 20 - 96)
    expect(x).toBeGreaterThan(0)
  })

  it("a same-tick setOffsetImmediate-then-beginThrow starts physics from the fresh position", () => {
    // Regression: a drag release computes the exact drop point via
    // setOffsetImmediate, then immediately hands off to beginThrow for a fast
    // release — beginThrow must read that fresh position, not a stale one
    // from before the render committed.
    const io = makeIo()
    const onSettle = jest.fn()
    const anchorRef = makeAnchorRef({ left: 0, top: 0 })
    const { result } = renderHook(() =>
      usePetWidgetThrow({ anchorRef, petSize: 96, onSettle, io: io.io })
    )
    act(() => {
      result.current.setOffsetImmediate(500, 10)
      result.current.beginThrow(0, 0)
    })
    // No vertical velocity and groundY = 800-0-96 = 704, well below the drop
    // point's y=10 — it should fall straight down from x=500, not from x=0.
    act(() => io.runToSettle())
    const [x] = onSettle.mock.calls[0] as [number, number]
    expect(x).toBe(500)
  })

  it("setOffsetImmediate moves without physics and cancels an in-flight throw", () => {
    const io = makeIo()
    const onSettle = jest.fn()
    const anchorRef = makeAnchorRef({ left: 0, top: 0 })
    const { result } = renderHook(() =>
      usePetWidgetThrow({ anchorRef, petSize: 96, onSettle, io: io.io })
    )
    act(() => result.current.beginThrow(0, -500))
    expect(io.rafCount()).toBe(1)
    act(() => result.current.setOffsetImmediate(30, 40))
    expect(result.current.offset).toEqual({ x: 30, y: 40 })
    expect(result.current.isThrowing).toBe(false)
    expect(io.rafCount()).toBe(0)
    expect(onSettle).not.toHaveBeenCalled()
  })

  it("unmounting cancels a pending rAF", () => {
    const io = makeIo()
    const anchorRef = makeAnchorRef({ left: 0, top: 0 })
    const { result, unmount } = renderHook(() =>
      usePetWidgetThrow({ anchorRef, petSize: 96, io: io.io })
    )
    act(() => result.current.beginThrow(0, -100))
    expect(io.rafCount()).toBe(1)
    unmount()
    expect(io.rafCount()).toBe(0)
  })
})
