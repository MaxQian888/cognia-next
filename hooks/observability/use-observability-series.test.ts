import { renderHook } from "@testing-library/react"
import { useObservabilitySeries } from "./use-observability-series"
import { customRange } from "@/lib/observability/time-range"
import { makeSpan } from "@/lib/observability/fixtures"

describe("useObservabilitySeries", () => {
  it("derives every series in one pass", () => {
    const range = customRange(0, 3000)
    const spans = [
      makeSpan({
        startTime: 100,
        durationMs: 100,
        costUsdEstimate: 0.1,
        surface: "chat",
        responseModel: "opus",
      }),
      makeSpan({ startTime: 2500, durationMs: 200, surface: "workflow", errorMessage: "x" }),
    ]
    const { result } = renderHook(() => useObservabilitySeries(spans, range))
    const s = result.current
    expect(s.bucketMs).toBeGreaterThan(0)
    expect(s.cost.points.length).toBeGreaterThan(0)
    expect(s.kpis.totalSpans).toBe(2)
    expect(s.breakdownModel.map((r) => r.key)).toContain("opus")
    expect(s.breakdownSurface.map((r) => r.key).sort()).toEqual(["chat", "workflow"])
    expect(s.traces.length).toBe(2)
  })

  it("is memoized on (spans, range)", () => {
    const range = customRange(0, 1000)
    const spans = [makeSpan({ startTime: 100 })]
    const { result, rerender } = renderHook(({ s, r }) => useObservabilitySeries(s, r), {
      initialProps: { s: spans, r: range },
    })
    const first = result.current
    rerender({ s: spans, r: range })
    expect(result.current).toBe(first)
  })
})
