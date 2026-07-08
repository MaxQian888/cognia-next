/** @jest-environment jsdom */
import { renderHook, act } from "@testing-library/react"

import { useElapsedSeconds } from "./use-elapsed-seconds"

describe("useElapsedSeconds", () => {
  it("returns 0 when inactive", () => {
    const { result } = renderHook(() => useElapsedSeconds(false))
    expect(result.current).toBe(0)
  })

  it("ticks once a second while active", () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useElapsedSeconds(true))
      expect(result.current).toBe(0)
      act(() => {
        jest.advanceTimersByTime(3000)
      })
      expect(result.current).toBe(3)
    } finally {
      jest.useRealTimers()
    }
  })

  it("resets to 0 once it goes inactive", () => {
    jest.useFakeTimers()
    try {
      const { result, rerender } = renderHook(({ on }) => useElapsedSeconds(on), {
        initialProps: { on: true },
      })
      act(() => {
        jest.advanceTimersByTime(2000)
      })
      expect(result.current).toBe(2)
      rerender({ on: false })
      expect(result.current).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
})
