/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { useNowTicker } from "./use-now-ticker"
import { nowTickerStore } from "@/lib/fleet/now-ticker-store"

describe("useNowTicker", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    nowTickerStore.resetForTests()
    jest.setSystemTime(1_000)
  })
  afterEach(() => {
    nowTickerStore.resetForTests()
    jest.useRealTimers()
  })

  it("returns the seeded time and advances every second", () => {
    const { result } = renderHook(() => useNowTicker())
    expect(result.current).toBe(1_000)
    // advanceTimersByTime moves both the interval and Date.now() forward.
    act(() => {
      jest.advanceTimersByTime(1_000)
    })
    expect(result.current).toBe(2_000)
  })

  it("tears down the shared interval when the last consumer unmounts", () => {
    const { unmount } = renderHook(() => useNowTicker())
    expect(jest.getTimerCount()).toBe(1)
    unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})
