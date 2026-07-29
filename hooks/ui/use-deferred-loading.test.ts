import { act, renderHook } from "@testing-library/react"

import {
  LOADING_DELAY_MS,
  LOADING_MIN_DISPLAY_MS,
  useDeferredLoading,
} from "./use-deferred-loading"

describe("useDeferredLoading", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    // Drop pending timers WITHOUT running them — executing them here would fire
    // a setState outside act() and warn.
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("shows nothing on the first frame", () => {
    const { result } = renderHook(() => useDeferredLoading(true))
    expect(result.current).toBe(false)
  })

  it("shows the indicator once the wait crosses the delay", () => {
    const { result } = renderHook(() => useDeferredLoading(true))
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    expect(result.current).toBe(true)
  })

  it("never shows anything for a load that beats the delay", () => {
    // The Dexie-first case: the read settles inside a frame, so the user should
    // see content appear, not a skeleton blink.
    const { result, rerender } = renderHook(({ loading }) => useDeferredLoading(loading), {
      initialProps: { loading: true },
    })
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS - 20)
    })
    rerender({ loading: false })
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(false)
  })

  it("holds a shown indicator for the minimum display time", () => {
    const { result, rerender } = renderHook(({ loading }) => useDeferredLoading(loading), {
      initialProps: { loading: true },
    })
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    expect(result.current).toBe(true)

    // Data lands immediately after the indicator appeared — the strobe window.
    rerender({ loading: false })
    act(() => {
      jest.advanceTimersByTime(LOADING_MIN_DISPLAY_MS - 20)
    })
    expect(result.current).toBe(true)

    act(() => {
      jest.advanceTimersByTime(20)
    })
    expect(result.current).toBe(false)
  })

  it("does not hold past the minimum once it has already elapsed", () => {
    const { result, rerender } = renderHook(({ loading }) => useDeferredLoading(loading), {
      initialProps: { loading: true },
    })
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS + LOADING_MIN_DISPLAY_MS + 500)
    })
    rerender({ loading: false })
    act(() => {
      jest.advanceTimersByTime(0)
    })
    expect(result.current).toBe(false)
  })

  it("resets immediately when the key changes", () => {
    // Switching sessions must not inherit the previous one's minimum-display
    // debt, which would strand its skeleton over the new session's content.
    const { result, rerender } = renderHook(
      ({ loading, key }) => useDeferredLoading(loading, { key }),
      { initialProps: { loading: true, key: "a" } }
    )
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    expect(result.current).toBe(true)

    rerender({ loading: true, key: "b" })
    expect(result.current).toBe(false)

    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    expect(result.current).toBe(true)
  })

  it("honours custom thresholds", () => {
    const { result } = renderHook(() => useDeferredLoading(true, { delayMs: 50 }))
    act(() => {
      jest.advanceTimersByTime(49)
    })
    expect(result.current).toBe(false)
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })

  it("drops its pending timer on unmount", () => {
    const { unmount } = renderHook(() => useDeferredLoading(true))
    unmount()
    // Would throw an act() warning if the timer still fired a setState.
    expect(() => jest.advanceTimersByTime(LOADING_DELAY_MS * 4)).not.toThrow()
  })
})
