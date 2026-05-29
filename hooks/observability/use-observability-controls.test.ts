import { act, renderHook } from "@testing-library/react"
import { useObservabilityControls, useResolvedRange } from "./use-observability-controls"
import { useObservabilityStore } from "@/stores/observability/observability-store"

beforeEach(() => {
  useObservabilityStore.setState({
    layouts: null,
    rangePreset: "1h",
    customSince: null,
    customUntil: null,
    refreshMs: 10_000,
    filters: {},
    editMode: false,
  })
})

describe("useObservabilityControls", () => {
  it("exposes store state and setters", () => {
    const { result } = renderHook(() => useObservabilityControls())
    expect(result.current.rangePreset).toBe("1h")
    act(() => result.current.setRangePreset("24h"))
    expect(useObservabilityStore.getState().rangePreset).toBe("24h")
  })

  it("setFilters round-trips", () => {
    const { result } = renderHook(() => useObservabilityControls())
    act(() => result.current.setFilters({ surface: ["chat"] }))
    expect(useObservabilityStore.getState().filters).toEqual({ surface: ["chat"] })
  })
})

describe("useResolvedRange", () => {
  it("resolves a relative preset to an absolute window", () => {
    const { result } = renderHook(() => useResolvedRange(0))
    expect(result.current.preset).toBe("1h")
    expect(result.current.until - result.current.since).toBe(3_600_000)
  })

  it("resolves a custom range", () => {
    act(() => useObservabilityStore.getState().setCustomRange(100, 200))
    const { result } = renderHook(() => useResolvedRange(0))
    expect(result.current).toMatchObject({ since: 100, until: 200, preset: "custom" })
  })

  it("recomputes when the tick advances", () => {
    const { result, rerender } = renderHook(({ tick }) => useResolvedRange(tick), {
      initialProps: { tick: 0 },
    })
    const first = result.current.until
    // Advance wall clock a hair so a re-resolve yields a later `until`.
    const realNow = Date.now
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000)
    rerender({ tick: 1 })
    expect(result.current.until).toBeGreaterThan(first)
    ;(Date.now as jest.Mock).mockRestore()
  })
})
