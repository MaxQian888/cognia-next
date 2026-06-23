import { act, renderHook } from "@testing-library/react"

import { useAutoRetryOnReconnect } from "./use-auto-retry-on-reconnect"

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("useAutoRetryOnReconnect", () => {
  it("starts a countdown on offline→online and fires onRetry at zero", () => {
    const onRetry = jest.fn()
    const { result, rerender } = renderHook(
      ({ online }) => useAutoRetryOnReconnect({ enabled: true, online, onRetry }),
      { initialProps: { online: false } }
    )

    expect(result.current.pending).toBe(false)

    rerender({ online: true })
    expect(result.current.pending).toBe(true)
    expect(result.current.secondsLeft).toBe(3)

    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(result.current.secondsLeft).toBe(2)

    act(() => {
      jest.advanceTimersByTime(2000)
    })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
    expect(result.current.secondsLeft).toBe(0)
  })

  it("respects a custom countdownSeconds", () => {
    const onRetry = jest.fn()
    const { result, rerender } = renderHook(
      ({ online }) =>
        useAutoRetryOnReconnect({ enabled: true, online, onRetry, countdownSeconds: 5 }),
      { initialProps: { online: false } }
    )
    rerender({ online: true })
    expect(result.current.secondsLeft).toBe(5)
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("cancel() aborts the countdown without retrying", () => {
    const onRetry = jest.fn()
    const { result, rerender } = renderHook(
      ({ online }) => useAutoRetryOnReconnect({ enabled: true, online, onRetry }),
      { initialProps: { online: false } }
    )
    rerender({ online: true })
    expect(result.current.pending).toBe(true)

    act(() => {
      result.current.cancel()
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.secondsLeft).toBe(0)

    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("is inert when disabled — no countdown on reconnect", () => {
    const onRetry = jest.fn()
    const { result, rerender } = renderHook(
      ({ online }) => useAutoRetryOnReconnect({ enabled: false, online, onRetry }),
      { initialProps: { online: false } }
    )
    rerender({ online: true })
    expect(result.current.pending).toBe(false)
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("stands down if disabled mid-countdown", () => {
    const onRetry = jest.fn()
    const { result, rerender } = renderHook(
      ({ online, enabled }) => useAutoRetryOnReconnect({ enabled, online, onRetry }),
      { initialProps: { online: false, enabled: true } }
    )
    rerender({ online: true, enabled: true })
    expect(result.current.pending).toBe(true)

    rerender({ online: true, enabled: false })
    expect(result.current.pending).toBe(false)
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("does not start when already online (no transition)", () => {
    const onRetry = jest.fn()
    const { result } = renderHook(() =>
      useAutoRetryOnReconnect({ enabled: true, online: true, onRetry })
    )
    expect(result.current.pending).toBe(false)
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("clears the interval on unmount", () => {
    const onRetry = jest.fn()
    const clearSpy = jest.spyOn(global, "clearInterval")
    const { rerender, unmount } = renderHook(
      ({ online }) => useAutoRetryOnReconnect({ enabled: true, online, onRetry }),
      { initialProps: { online: false } }
    )
    rerender({ online: true })
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
