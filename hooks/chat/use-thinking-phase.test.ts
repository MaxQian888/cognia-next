import { act, renderHook } from "@testing-library/react"

import {
  SKELETON_AT_MS,
  TIPS_AT_MS,
  TIP_ROTATE_MS,
  VERB_ROTATE_MS,
  useThinkingPhase,
} from "./use-thinking-phase"

describe("useThinkingPhase", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    // Drop any still-scheduled timers WITHOUT executing them — running them
    // here would fire an interval's setState outside act() and warn.
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("starts in phase 1 with nothing revealed", () => {
    const { result } = renderHook(() => useThinkingPhase({ tipCount: 3 }))
    expect(result.current).toEqual({
      showSkeleton: false,
      showTips: false,
      tipIndex: 0,
      verbIndex: 0,
    })
  })

  it("reveals the skeleton at the skeleton threshold", () => {
    const { result } = renderHook(() => useThinkingPhase({ tipCount: 3 }))
    act(() => {
      jest.advanceTimersByTime(SKELETON_AT_MS)
    })
    expect(result.current.showSkeleton).toBe(true)
    expect(result.current.showTips).toBe(false)
  })

  it("reveals tips at the tips threshold", () => {
    const { result } = renderHook(() => useThinkingPhase({ tipCount: 3 }))
    act(() => {
      jest.advanceTimersByTime(TIPS_AT_MS)
    })
    expect(result.current.showSkeleton).toBe(true)
    expect(result.current.showTips).toBe(true)
    expect(result.current.tipIndex).toBe(0)
  })

  it("rotates the tip index every rotation interval after tips appear", () => {
    const { result } = renderHook(() => useThinkingPhase({ tipCount: 3 }))
    act(() => {
      jest.advanceTimersByTime(TIPS_AT_MS)
    })
    expect(result.current.tipIndex).toBe(0)
    act(() => {
      jest.advanceTimersByTime(TIP_ROTATE_MS)
    })
    expect(result.current.tipIndex).toBe(1)
    act(() => {
      jest.advanceTimersByTime(TIP_ROTATE_MS)
    })
    expect(result.current.tipIndex).toBe(2)
    // Wraps back to 0.
    act(() => {
      jest.advanceTimersByTime(TIP_ROTATE_MS)
    })
    expect(result.current.tipIndex).toBe(0)
  })

  it("does not rotate when motion is reduced", () => {
    const { result } = renderHook(() => useThinkingPhase({ tipCount: 3, reduce: true }))
    act(() => {
      jest.advanceTimersByTime(TIPS_AT_MS + TIP_ROTATE_MS * 3)
    })
    expect(result.current.showTips).toBe(true)
    expect(result.current.tipIndex).toBe(0)
  })

  it("does not rotate when there is at most one tip", () => {
    const { result } = renderHook(() => useThinkingPhase({ tipCount: 1 }))
    act(() => {
      jest.advanceTimersByTime(TIPS_AT_MS + TIP_ROTATE_MS * 2)
    })
    expect(result.current.showTips).toBe(true)
    expect(result.current.tipIndex).toBe(0)
  })

  it("honors custom thresholds", () => {
    const { result } = renderHook(() =>
      useThinkingPhase({ tipCount: 2, skeletonAtMs: 100, tipsAtMs: 200, tipRotateMs: 300 })
    )
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(result.current.showSkeleton).toBe(true)
    expect(result.current.showTips).toBe(false)
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(result.current.showTips).toBe(true)
    act(() => {
      jest.advanceTimersByTime(300)
    })
    expect(result.current.tipIndex).toBe(1)
  })

  // Verb rotation is the only motion during a long tool-heavy stretch, so it
  // runs on its own clock from mount rather than behind a reveal threshold.
  it("rotates the verb index from mount, with no threshold to wait out", () => {
    const { result } = renderHook(() => useThinkingPhase({ verbCount: 3 }))
    expect(result.current.verbIndex).toBe(0)
    act(() => {
      jest.advanceTimersByTime(VERB_ROTATE_MS)
    })
    expect(result.current.verbIndex).toBe(1)
    act(() => {
      jest.advanceTimersByTime(VERB_ROTATE_MS * 2)
    })
    // Wrapped back around: 1 → 2 → 0.
    expect(result.current.verbIndex).toBe(0)
  })

  it("does not rotate verbs when motion is reduced", () => {
    const { result } = renderHook(() => useThinkingPhase({ verbCount: 3, reduce: true }))
    act(() => {
      jest.advanceTimersByTime(VERB_ROTATE_MS * 4)
    })
    expect(result.current.verbIndex).toBe(0)
  })

  it("does not rotate when there is at most one verb", () => {
    const { result } = renderHook(() => useThinkingPhase({ verbCount: 1 }))
    act(() => {
      jest.advanceTimersByTime(VERB_ROTATE_MS * 3)
    })
    expect(result.current.verbIndex).toBe(0)
  })

  it("honors a custom verb rotation interval", () => {
    const { result } = renderHook(() => useThinkingPhase({ verbCount: 2, verbRotateMs: 50 }))
    act(() => {
      jest.advanceTimersByTime(50)
    })
    expect(result.current.verbIndex).toBe(1)
  })

  it("keeps verb rotation running independent of the tip clock", () => {
    // tipCount 1 ⇒ no tip rotation; verbs must still cycle.
    const { result } = renderHook(() => useThinkingPhase({ tipCount: 1, verbCount: 2 }))
    act(() => {
      jest.advanceTimersByTime(VERB_ROTATE_MS)
    })
    expect(result.current.tipIndex).toBe(0)
    expect(result.current.verbIndex).toBe(1)
  })

  it("clears all timers on unmount (no rotation after teardown)", () => {
    const clearTimeoutSpy = jest.spyOn(globalThis, "clearTimeout")
    const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval")
    const { result, unmount } = renderHook(() => useThinkingPhase({ tipCount: 3 }))
    act(() => {
      jest.advanceTimersByTime(TIPS_AT_MS)
    })
    expect(result.current.tipIndex).toBe(0)
    unmount()
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(clearIntervalSpy).toHaveBeenCalled()
    // Advancing past unmount must not throw or rotate further.
    act(() => {
      jest.advanceTimersByTime(TIP_ROTATE_MS * 2)
    })
    clearTimeoutSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  })
})
