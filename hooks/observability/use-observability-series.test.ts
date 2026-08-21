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
    // `provider` / `project` back the ADR-0130 cost-attribution panels; before
    // they existed those panels silently plotted the model rollup.
    expect(s.breakdownProvider.map((r) => r.key)).toContain("anthropic")
    expect(s.breakdownProject).toEqual([])
    expect(s.kpis.toolCalls).toBe(0)
  })

  it("counts execute_tool spans and their failures as tool KPIs", () => {
    const range = customRange(0, 3000)
    const spans = [
      makeSpan({ startTime: 100, operationName: "execute_tool", toolName: "read_file" }),
      makeSpan({
        startTime: 200,
        operationName: "execute_tool",
        toolName: "web_search",
        errorMessage: "boom",
      }),
      makeSpan({ startTime: 300, operationName: "chat" }),
    ]
    const { result } = renderHook(() => useObservabilitySeries(spans, range))
    expect(result.current.kpis.toolCalls).toBe(2)
    expect(result.current.kpis.toolFailures).toBe(1)
    expect(result.current.breakdownTool.map((r) => r.key).sort()).toEqual([
      "read_file",
      "web_search",
    ])
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
