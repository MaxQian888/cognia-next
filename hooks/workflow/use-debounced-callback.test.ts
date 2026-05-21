/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import { useDebouncedCallback } from "./use-debounced-callback"

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("coalesces multiple call()s into a single trailing fire; latest args win", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useDebouncedCallback<[number]>(fn, 100))

    act(() => {
      result.current.call(1)
      result.current.call(2)
      result.current.call(3)
    })

    expect(fn).not.toHaveBeenCalled()
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)
  })

  it("resets the timer on each call so the window restarts from the latest call", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useDebouncedCallback<[number]>(fn, 100))

    act(() => result.current.call(1))
    act(() => {
      jest.advanceTimersByTime(80)
    })
    expect(fn).not.toHaveBeenCalled()

    // Calling again before the window closes resets the timer.
    act(() => result.current.call(2))
    act(() => {
      jest.advanceTimersByTime(80)
    })
    expect(fn).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(20)
    })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(2)
  })

  it("schedules a new window after the previous one drained", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useDebouncedCallback<[number]>(fn, 50))

    act(() => result.current.call(1))
    act(() => {
      jest.advanceTimersByTime(50)
    })
    expect(fn).toHaveBeenCalledWith(1)

    act(() => result.current.call(2))
    act(() => {
      jest.advanceTimersByTime(50)
    })
    expect(fn).toHaveBeenCalledWith(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("flush() invokes immediately with the latest args and clears the pending timer", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useDebouncedCallback<[number]>(fn, 100))

    act(() => {
      result.current.call(7)
      result.current.flush()
    })

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(7)

    // Advancing past the original window must not double-fire.
    act(() => {
      jest.advanceTimersByTime(200)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("flush() with no pending args is a no-op", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useDebouncedCallback(fn, 100))
    act(() => result.current.flush())
    expect(fn).not.toHaveBeenCalled()
  })

  it("cancel() discards pending args without invoking", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useDebouncedCallback<[number]>(fn, 100))

    act(() => {
      result.current.call(99)
      result.current.cancel()
    })
    act(() => {
      jest.advanceTimersByTime(200)
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it("returns stable handle identities across renders", () => {
    const { result, rerender } = renderHook(({ fn, delay }) => useDebouncedCallback(fn, delay), {
      initialProps: { fn: () => {}, delay: 100 },
    })
    const first = result.current
    rerender({ fn: () => {}, delay: 100 })
    expect(result.current.call).toBe(first.call)
    expect(result.current.flush).toBe(first.flush)
    expect(result.current.cancel).toBe(first.cancel)
  })

  it("invokes the LATEST closure even when call identity is stable", () => {
    const fnA = jest.fn()
    const fnB = jest.fn()
    const { result, rerender } = renderHook(({ fn }) => useDebouncedCallback(fn, 50), {
      initialProps: { fn: fnA },
    })
    rerender({ fn: fnB })

    act(() => result.current.call())
    act(() => {
      jest.advanceTimersByTime(50)
    })
    expect(fnA).not.toHaveBeenCalled()
    expect(fnB).toHaveBeenCalledTimes(1)
  })

  it("uses the LATEST delay when prop changes mid-flight", () => {
    const fn = jest.fn()
    const { result, rerender } = renderHook(
      ({ delay }) => useDebouncedCallback<[number]>(fn, delay),
      { initialProps: { delay: 100 } }
    )
    rerender({ delay: 25 })

    act(() => result.current.call(1))
    act(() => {
      jest.advanceTimersByTime(25)
    })
    expect(fn).toHaveBeenCalledWith(1)
  })

  it("cancels the pending timer on unmount", () => {
    const fn = jest.fn()
    const { result, unmount } = renderHook(() => useDebouncedCallback<[number]>(fn, 100))
    act(() => result.current.call(1))
    unmount()
    act(() => {
      jest.advanceTimersByTime(200)
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it("delay <= 0 degrades to synchronous invocation", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useDebouncedCallback<[string]>(fn, 0))
    act(() => result.current.call("immediate"))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith("immediate")
  })
})
