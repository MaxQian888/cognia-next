import { act, renderHook } from "@testing-library/react"
import {
  usePetDragGesture,
  type PetDragGestureIo,
  type UsePetDragGestureArgs,
} from "./use-pet-drag-gesture"

/** Deterministic clock + manual rAF queue standing in for the browser. */
function makeIo() {
  let now = 0
  let nextId = 1
  const rafs = new Map<number, () => void>()
  const io: PetDragGestureIo = {
    now: () => now,
    raf: (cb) => {
      const id = nextId++
      rafs.set(id, cb)
      return id
    },
    caf: (id) => void rafs.delete(id),
  }
  const flushRaf = () => {
    const pending = [...rafs.values()]
    rafs.clear()
    for (const cb of pending) cb()
  }
  return { io, flushRaf, rafCount: () => rafs.size, advance: (ms: number) => (now += ms) }
}

function pointerEvent(overrides: Partial<React.PointerEvent> = {}): React.PointerEvent {
  return {
    button: 0,
    pointerId: 1,
    screenX: 0,
    screenY: 0,
    clientX: 0,
    clientY: 0,
    currentTarget: {
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
    } as unknown as Element,
    ...overrides,
  } as React.PointerEvent
}

function setup(args: Omit<UsePetDragGestureArgs, "onDragMove" | "onRelease"> = {}) {
  const io = makeIo()
  const onDragStart = jest.fn()
  const onDragMove = jest.fn()
  const onRelease = jest.fn()
  const onCancel = jest.fn()
  const { result, unmount } = renderHook(() =>
    usePetDragGesture({ onDragStart, onDragMove, onRelease, onCancel, io: io.io, ...args })
  )
  return { result, unmount, io, onDragStart, onDragMove, onRelease, onCancel }
}

describe("usePetDragGesture", () => {
  it("a small movement below threshold is a tap: no drag start/move, release wasDrag=false", () => {
    const { result, onDragStart, onDragMove, onRelease } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 2, screenY: 2 }))
      result.current.onPointerUp(pointerEvent({ pointerId: 1, screenX: 2, screenY: 2 }))
    })
    expect(onDragStart).not.toHaveBeenCalled()
    expect(onDragMove).not.toHaveBeenCalled()
    expect(onRelease).toHaveBeenCalledWith(
      expect.objectContaining({ wasDrag: false, dx: 2, dy: 2, vx: 0, vy: 0 })
    )
  })

  it("crossing the threshold starts a drag and rAF-batches onDragMove with cumulative deltas", () => {
    const { result, io, onDragStart, onDragMove } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 10, screenY: 0 }))
    })
    expect(onDragStart).toHaveBeenCalledTimes(1)
    // A second move before the rAF flushes must not trigger a second onDragMove call.
    act(() => {
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 20, screenY: 5 }))
    })
    expect(onDragMove).not.toHaveBeenCalled()
    act(() => io.flushRaf())
    expect(onDragMove).toHaveBeenCalledTimes(1)
    expect(onDragMove).toHaveBeenCalledWith(20, 5)
  })

  it("a fast release computes a nonzero velocity from recent samples", () => {
    const { result, io, onRelease } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 100, screenY: 0 }))
    })
    io.advance(100)
    act(() => {
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 2100, screenY: 40 }))
      io.flushRaf()
      result.current.onPointerUp(pointerEvent({ pointerId: 1, screenX: 2100, screenY: 40 }))
    })
    expect(onRelease).toHaveBeenCalledTimes(1)
    const info = onRelease.mock.calls[0][0]
    expect(info.wasDrag).toBe(true)
    expect(info.dx).toBe(2100)
    expect(info.dy).toBe(40)
    expect(info.vx).toBeGreaterThan(0)
  })

  it("a slow release (single sample) reports zero velocity", () => {
    const { result, onRelease } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 40, screenY: 30 }))
      result.current.onPointerUp(pointerEvent({ pointerId: 1, screenX: 40, screenY: 30 }))
    })
    const info = onRelease.mock.calls[0][0]
    expect(info.wasDrag).toBe(true)
    expect(info.vx).toBe(0)
    expect(info.vy).toBe(0)
  })

  it("ignores a non-matching button on pointer-down", () => {
    const { result, onRelease } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ button: 2, pointerId: 1 }))
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 50, screenY: 50 }))
      result.current.onPointerUp(pointerEvent({ pointerId: 1, screenX: 50, screenY: 50 }))
    })
    expect(onRelease).not.toHaveBeenCalled()
  })

  it("ignores move/up/cancel for a mismatched pointer id", () => {
    const { result, io, onDragMove, onRelease, onCancel } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
      result.current.onPointerMove(pointerEvent({ pointerId: 99, screenX: 50, screenY: 50 }))
      io.flushRaf()
      result.current.onPointerUp(pointerEvent({ pointerId: 99, screenX: 50, screenY: 50 }))
      result.current.onPointerCancel(pointerEvent({ pointerId: 99 }))
    })
    expect(onDragMove).not.toHaveBeenCalled()
    expect(onRelease).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("a pointer-up with no active press is a no-op", () => {
    const { result, onRelease } = setup()
    act(() => {
      result.current.onPointerUp(pointerEvent({ pointerId: 5 }))
    })
    expect(onRelease).not.toHaveBeenCalled()
  })

  it("cancel while dragging fires onCancel(wasDrag=true) and never onRelease", () => {
    const { result, io, onRelease, onCancel } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 50, screenY: 50 }))
      // Cancel before the pending rAF flushes.
      result.current.onPointerCancel(pointerEvent({ pointerId: 1, screenX: 50, screenY: 50 }))
    })
    expect(onCancel).toHaveBeenCalledWith({ wasDrag: true })
    expect(onRelease).not.toHaveBeenCalled()
    expect(io.rafCount()).toBe(0) // the pending rAF was canceled too
  })

  it("cancel on a tap (never crossed the threshold) reports wasDrag=false", () => {
    const { result, onCancel } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
      result.current.onPointerCancel(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
    })
    expect(onCancel).toHaveBeenCalledWith({ wasDrag: false })
  })

  it("unmounting cancels a pending rAF", () => {
    const { result, unmount, io } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
      result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: 50, screenY: 50 }))
    })
    expect(io.rafCount()).toBe(1)
    unmount()
    expect(io.rafCount()).toBe(0)
  })

  it("trims samples beyond the retention window", () => {
    const { result, io, onRelease } = setup()
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 1, screenX: 0, screenY: 0 }))
    })
    // 10 moves, each 1px apart in time, all crossing the threshold cumulatively.
    for (let i = 1; i <= 10; i++) {
      act(() => {
        result.current.onPointerMove(pointerEvent({ pointerId: 1, screenX: i * 10, screenY: 0 }))
        io.advance(10)
      })
    }
    act(() => {
      result.current.onPointerUp(pointerEvent({ pointerId: 1, screenX: 100, screenY: 0 }))
    })
    expect(onRelease).toHaveBeenCalledTimes(1)
    expect(onRelease.mock.calls[0][0].dx).toBe(100)
  })
})
