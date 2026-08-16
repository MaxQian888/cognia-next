import { act, renderHook } from "@testing-library/react"

import { ESCALATED_AT_MS, PROLONGED_AT_MS, useLoadingPhase } from "./use-loading-phase"

const mockNetwork = { connected: true, connectionType: "wifi" as const }

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ loading: false, status: mockNetwork }),
}))

describe("useLoadingPhase", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockNetwork.connected = true
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("starts plain — a short wait gets no extra commentary", () => {
    const { result } = renderHook(() => useLoadingPhase())
    expect(result.current.phase).toBe("visible")
    expect(result.current.elapsedMs).toBe(0)
    expect(result.current.offline).toBe(false)
  })

  it("turns prolonged at the threshold and reports elapsed time", () => {
    const { result } = renderHook(() => useLoadingPhase())
    act(() => {
      jest.advanceTimersByTime(PROLONGED_AT_MS)
    })
    expect(result.current.phase).toBe("prolonged")
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(PROLONGED_AT_MS)
  })

  it("never escalates when the caller cannot cancel", () => {
    // An escalation with no action is just a more alarming spinner.
    const { result } = renderHook(() => useLoadingPhase())
    act(() => {
      jest.advanceTimersByTime(ESCALATED_AT_MS * 2)
    })
    expect(result.current.phase).toBe("prolonged")
  })

  it("escalates at the threshold when cancelling is possible", () => {
    const { result } = renderHook(() => useLoadingPhase({ canEscalate: true }))
    act(() => {
      jest.advanceTimersByTime(PROLONGED_AT_MS)
    })
    expect(result.current.phase).toBe("prolonged")
    act(() => {
      jest.advanceTimersByTime(ESCALATED_AT_MS - PROLONGED_AT_MS)
    })
    expect(result.current.phase).toBe("escalated")
  })

  it("stays quiet about a connection blip during a short wait", () => {
    mockNetwork.connected = false
    const { result } = renderHook(() => useLoadingPhase())
    act(() => {
      jest.advanceTimersByTime(PROLONGED_AT_MS - 1000)
    })
    // Being offline did not make this fast local read fail; saying so would lie.
    expect(result.current.offline).toBe(false)
  })

  it("reports offline once the wait is both long and disconnected", () => {
    mockNetwork.connected = false
    const { result } = renderHook(() => useLoadingPhase())
    act(() => {
      jest.advanceTimersByTime(PROLONGED_AT_MS)
    })
    expect(result.current.offline).toBe(true)
  })

  it("honours custom thresholds", () => {
    const { result } = renderHook(() =>
      useLoadingPhase({ prolongedAtMs: 100, escalatedAtMs: 200, canEscalate: true, tickMs: 50 })
    )
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(result.current.phase).toBe("prolonged")
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(result.current.phase).toBe("escalated")
  })

  it("drops its interval on unmount", () => {
    const { unmount } = renderHook(() => useLoadingPhase())
    unmount()
    expect(() => jest.advanceTimersByTime(ESCALATED_AT_MS)).not.toThrow()
  })

  describe("anchored to an earlier start", () => {
    it("reports the true elapsed time on the very first render", () => {
      const startedAt = Date.now() - 7000
      const { result } = renderHook(() => useLoadingPhase({ startedAt }))
      // No tick has fired yet, but the wait began 7s ago and must say so.
      expect(result.current.elapsedMs).toBeGreaterThanOrEqual(7000)
      expect(result.current.phase).toBe("prolonged")
    })

    it("keeps counting from the anchor, not from mount", () => {
      const startedAt = Date.now() - 3000
      const { result } = renderHook(() => useLoadingPhase({ startedAt, canEscalate: true }))
      act(() => {
        jest.advanceTimersByTime(2000)
      })
      expect(result.current.elapsedMs).toBeGreaterThanOrEqual(5000)
      expect(result.current.phase).toBe("prolonged")
      act(() => {
        jest.advanceTimersByTime(10000)
      })
      expect(result.current.phase).toBe("escalated")
    })

    it("never reports a negative elapsed time for an anchor in the future", () => {
      const { result } = renderHook(() => useLoadingPhase({ startedAt: Date.now() + 60_000 }))
      expect(result.current.elapsedMs).toBe(0)
      act(() => {
        jest.advanceTimersByTime(1000)
      })
      expect(result.current.elapsedMs).toBe(0)
    })

    it("re-anchors when the start moves", () => {
      let startedAt: number | null = null
      const { result, rerender } = renderHook(() => useLoadingPhase({ startedAt }))
      expect(result.current.elapsedMs).toBe(0)
      startedAt = Date.now() - 6000
      rerender()
      act(() => {
        jest.advanceTimersByTime(1000)
      })
      expect(result.current.elapsedMs).toBeGreaterThanOrEqual(7000)
      expect(result.current.phase).toBe("prolonged")
    })
  })
})
