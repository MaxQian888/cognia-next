import { act, renderHook } from "@testing-library/react"
import { useRefreshTick } from "./use-refresh-tick"

describe("useRefreshTick", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("starts at 0", () => {
    const { result } = renderHook(() => useRefreshTick(1000))
    expect(result.current).toBe(0)
  })

  it("increments on each interval", () => {
    const { result } = renderHook(() => useRefreshTick(1000))
    act(() => {
      jest.advanceTimersByTime(3000)
    })
    expect(result.current).toBe(3)
  })

  it("does not tick when disabled (0)", () => {
    const { result } = renderHook(() => useRefreshTick(0))
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(result.current).toBe(0)
  })

  it("does not tick for non-finite intervals", () => {
    const { result } = renderHook(() => useRefreshTick(Number.NaN))
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(result.current).toBe(0)
  })

  it("resets the timer when the interval changes", () => {
    const { result, rerender } = renderHook(({ ms }) => useRefreshTick(ms), {
      initialProps: { ms: 1000 },
    })
    act(() => jest.advanceTimersByTime(1000))
    expect(result.current).toBe(1)
    rerender({ ms: 500 })
    act(() => jest.advanceTimersByTime(1000))
    expect(result.current).toBe(3) // 1 + 2 more at 500ms
  })

  it("clears the timer on unmount", () => {
    const clearSpy = jest.spyOn(globalThis, "clearInterval")
    const { unmount } = renderHook(() => useRefreshTick(1000))
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
