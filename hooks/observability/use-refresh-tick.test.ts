import { act, renderHook } from "@testing-library/react"
import { useRefreshTick } from "./use-refresh-tick"

describe("useRefreshTick", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("starts at 0", () => {
    const { result } = renderHook(() => useRefreshTick(1000))
    expect(result.current.tick).toBe(0)
  })

  it("stamps lastUpdated on mount", () => {
    const now = 1_700_000_000_000
    jest.setSystemTime(now)
    const { result } = renderHook(() => useRefreshTick(1000))
    // Initial stamp is deferred to a macrotask.
    act(() => {
      jest.advanceTimersByTime(0)
    })
    expect(result.current.lastUpdated).toBe(now)
  })

  it("increments on each interval and advances lastUpdated", () => {
    jest.setSystemTime(0)
    const { result } = renderHook(() => useRefreshTick(1000))
    act(() => {
      jest.advanceTimersByTime(3000)
    })
    expect(result.current.tick).toBe(3)
    expect(result.current.lastUpdated).toBe(3000)
  })

  it("ticks immediately on manual refresh()", () => {
    const { result } = renderHook(() => useRefreshTick(0))
    act(() => {
      result.current.refresh()
    })
    expect(result.current.tick).toBe(1)
  })

  it("does not tick when disabled (0)", () => {
    const { result } = renderHook(() => useRefreshTick(0))
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(result.current.tick).toBe(0)
  })

  it("does not tick for non-finite intervals", () => {
    const { result } = renderHook(() => useRefreshTick(Number.NaN))
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(result.current.tick).toBe(0)
  })

  it("resets the timer when the interval changes", () => {
    const { result, rerender } = renderHook(({ ms }) => useRefreshTick(ms), {
      initialProps: { ms: 1000 },
    })
    act(() => jest.advanceTimersByTime(1000))
    expect(result.current.tick).toBe(1)
    rerender({ ms: 500 })
    act(() => jest.advanceTimersByTime(1000))
    expect(result.current.tick).toBe(3) // 1 + 2 more at 500ms
  })

  it("clears the timer on unmount", () => {
    const clearSpy = jest.spyOn(globalThis, "clearInterval")
    const { unmount } = renderHook(() => useRefreshTick(1000))
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
