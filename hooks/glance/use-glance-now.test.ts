/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { GLANCE_TICK_MS, useGlanceNow } from "./use-glance-now"

describe("useGlanceNow", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(1_000_000)
  })
  afterEach(() => jest.useRealTimers())

  it("reads the clock once and stays frozen while inactive", () => {
    const { result } = renderHook(() => useGlanceNow(false))
    expect(result.current).toBe(1_000_000)
    act(() => {
      jest.advanceTimersByTime(GLANCE_TICK_MS * 4)
    })
    expect(result.current).toBe(1_000_000)
  })

  it("re-reads at once on becoming active, then on every tick", () => {
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useGlanceNow(on), {
      initialProps: { on: false },
    })
    jest.setSystemTime(2_000_000)
    rerender({ on: true })
    act(() => {
      jest.advanceTimersByTime(0)
    })
    expect(result.current).toBe(2_000_000)
    act(() => {
      jest.advanceTimersByTime(GLANCE_TICK_MS)
    })
    expect(result.current).toBe(2_000_000 + GLANCE_TICK_MS)
  })

  it("stops ticking when deactivated", () => {
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useGlanceNow(on), {
      initialProps: { on: true },
    })
    act(() => {
      jest.advanceTimersByTime(GLANCE_TICK_MS)
    })
    const frozen = result.current
    rerender({ on: false })
    act(() => {
      jest.advanceTimersByTime(GLANCE_TICK_MS * 3)
    })
    expect(result.current).toBe(frozen)
  })
})
