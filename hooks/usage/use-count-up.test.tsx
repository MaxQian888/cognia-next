/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useCountUp } from "./use-count-up"

// Drive requestAnimationFrame deterministically: capture queued callbacks and
// flush them with explicit timestamps so the tween maths is testable.
let rafQueue: Array<(ts: number) => void> = []
let rafId = 0

beforeEach(() => {
  rafQueue = []
  rafId = 0
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafQueue.push(cb as (ts: number) => void)
    return ++rafId
  })
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

/** Flush the next queued frame with a timestamp. */
function flushFrame(ts: number) {
  const cb = rafQueue.shift()
  if (cb) act(() => cb(ts))
}

describe("useCountUp", () => {
  it("returns the target immediately when disabled", () => {
    const { result } = renderHook(() => useCountUp(100, { disabled: true }))
    expect(result.current).toBe(100)
    expect(rafQueue).toHaveLength(0)
  })

  it("returns the target immediately for zero duration", () => {
    const { result } = renderHook(() => useCountUp(50, { durationMs: 0 }))
    expect(result.current).toBe(50)
  })

  it("short-circuits non-finite targets", () => {
    const { result } = renderHook(() => useCountUp(Number.NaN))
    expect(Number.isNaN(result.current)).toBe(true)
    expect(rafQueue).toHaveLength(0)
  })

  it("tweens from the previous value to the new target", () => {
    const { result, rerender } = renderHook(
      ({ target }) => useCountUp(target, { durationMs: 1000 }),
      {
        initialProps: { target: 0 },
      }
    )
    expect(result.current).toBe(0)

    rerender({ target: 100 })
    // First frame establishes the start timestamp (t = 0 → still origin).
    flushFrame(1000)
    expect(result.current).toBe(0)

    // Halfway through: ease-out cubic → 1-(0.5)^3 = 0.875 of the way.
    flushFrame(1500)
    expect(result.current).toBeCloseTo(87.5, 1)

    // End of the tween snaps exactly to the target.
    flushFrame(2000)
    expect(result.current).toBe(100)
  })

  it("does not schedule a frame when the target is unchanged", () => {
    const { rerender } = renderHook(({ target }) => useCountUp(target, { durationMs: 500 }), {
      initialProps: { target: 42 },
    })
    rafQueue = []
    rerender({ target: 42 })
    expect(rafQueue).toHaveLength(0)
  })

  it("cancels the pending frame on unmount", () => {
    const cancelSpy = window.cancelAnimationFrame as jest.Mock
    const { rerender, unmount } = renderHook(
      ({ target }) => useCountUp(target, { durationMs: 1000 }),
      { initialProps: { target: 0 } }
    )
    rerender({ target: 100 })
    flushFrame(0) // schedules a follow-up frame
    unmount()
    expect(cancelSpy).toHaveBeenCalled()
  })
})
