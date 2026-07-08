/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useSteerQueue } from "./use-steer-queue"

describe("useSteerQueue", () => {
  it("returns null and dispatches nothing when the queue is empty", () => {
    const dispatch = jest.fn()
    const { result } = renderHook(() => useSteerQueue([], dispatch))
    expect(result.current.takeSteer()).toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("joins the queued steers, clears the queue, and dispatches STEER_CLEAR", () => {
    const dispatch = jest.fn()
    const { result } = renderHook(() => useSteerQueue(["a", "b"], dispatch))
    let drained: string | null = null
    act(() => {
      drained = result.current.takeSteer()
    })
    expect(drained).toBe("a\nb")
    expect(dispatch).toHaveBeenCalledWith({ type: "STEER_CLEAR" })
    // A second drain is empty (the ref was reset).
    expect(result.current.takeSteer()).toBeNull()
  })

  it("mirrors the latest queue into the ref when the prop changes", () => {
    const dispatch = jest.fn()
    const { result, rerender } = renderHook(({ q }) => useSteerQueue(q, dispatch), {
      initialProps: { q: ["one"] },
    })
    rerender({ q: ["one", "two", "three"] })
    expect(result.current.steerRef.current).toEqual(["one", "two", "three"])
    expect(result.current.takeSteer()).toBe("one\ntwo\nthree")
  })
})
