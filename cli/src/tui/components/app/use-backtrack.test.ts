import { act, renderHook } from "@testing-library/react"

import { useBacktrack } from "./use-backtrack"

describe("useBacktrack", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("starts disarmed", () => {
    const { result } = renderHook(() => useBacktrack())
    expect(result.current.backtrackArmed).toBe(false)
    expect(result.current.backtrackArmedRef.current).toBe(false)
  })

  it("arms (state + ref) and auto-disarms after the window elapses", () => {
    const { result } = renderHook(() => useBacktrack())
    act(() => result.current.armBacktrack())
    expect(result.current.backtrackArmed).toBe(true)
    expect(result.current.backtrackArmedRef.current).toBe(true)
    act(() => jest.advanceTimersByTime(1500))
    expect(result.current.backtrackArmed).toBe(false)
    expect(result.current.backtrackArmedRef.current).toBe(false)
  })

  it("disarm cancels the pending auto-disarm timer", () => {
    const { result } = renderHook(() => useBacktrack())
    act(() => result.current.armBacktrack())
    act(() => result.current.disarmBacktrack())
    expect(result.current.backtrackArmed).toBe(false)
    // Advancing past the original window must not re-fire any state change.
    act(() => jest.advanceTimersByTime(2000))
    expect(result.current.backtrackArmed).toBe(false)
  })

  it("re-arming resets the timer (no early disarm from the first arm)", () => {
    const { result } = renderHook(() => useBacktrack())
    act(() => result.current.armBacktrack())
    act(() => jest.advanceTimersByTime(1000))
    act(() => result.current.armBacktrack())
    act(() => jest.advanceTimersByTime(1000))
    // 2000ms total elapsed but only 1000ms since the re-arm → still armed.
    expect(result.current.backtrackArmed).toBe(true)
  })
})
