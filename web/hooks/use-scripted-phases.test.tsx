/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { useScriptedPhases } from "./use-scripted-phases"

const DELAYS = [100, 200, 300] as const

describe("useScriptedPhases", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("opens on phase 0 and advances through every delay in order", () => {
    const { result } = renderHook(() => useScriptedPhases({ delays: DELAYS, enabled: true }))
    expect(result.current).toBe(0)

    act(() => jest.advanceTimersByTime(100))
    expect(result.current).toBe(1)

    act(() => jest.advanceTimersByTime(200))
    expect(result.current).toBe(2)

    act(() => jest.advanceTimersByTime(300))
    expect(result.current).toBe(3)
  })

  it("stops on the final phase rather than looping back", () => {
    const { result } = renderHook(() => useScriptedPhases({ delays: DELAYS, enabled: true }))
    act(() => jest.advanceTimersByTime(10_000))
    expect(result.current).toBe(DELAYS.length)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("reports the complete state immediately when disabled", () => {
    // Reduced motion is the absence of the sequence, not a fast version of it:
    // the reader sees the finished surface on the first frame.
    const { result } = renderHook(() => useScriptedPhases({ delays: DELAYS, enabled: false }))
    expect(result.current).toBe(DELAYS.length)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("restarts from the opening state when re-enabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useScriptedPhases({ delays: DELAYS, enabled }),
      { initialProps: { enabled: true } }
    )
    act(() => jest.advanceTimersByTime(300))
    expect(result.current).toBe(2)

    rerender({ enabled: false })
    expect(result.current).toBe(DELAYS.length)

    rerender({ enabled: true })
    expect(result.current).toBe(0)
  })

  it("clears its pending timer on unmount", () => {
    const { unmount } = renderHook(() => useScriptedPhases({ delays: DELAYS, enabled: true }))
    expect(jest.getTimerCount()).toBe(1)
    unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})
