/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import type { AgentTraceSpan } from "@/types/agent-trace/span"

import { useTraceList } from "./use-trace-list"

function span(overrides: Partial<AgentTraceSpan> & { traceId: string }): AgentTraceSpan {
  return {
    id: `${overrides.traceId}-${overrides.spanId ?? "root"}`,
    spanId: overrides.spanId ?? "root",
    startTime: 1_000,
    durationMs: 10,
    operationName: "invoke_agent",
    providerName: "anthropic",
    sessionId: "s1",
    surface: "chat",
    ...overrides,
  } as AgentTraceSpan
}

describe("useTraceList", () => {
  it("passes the caller's loading flag through with no rows of its own", () => {
    const { result } = renderHook(() => useTraceList({ spans: [], loading: true }))
    expect(result.current.loading).toBe(true)
    expect(result.current.traces).toEqual([])
  })

  it("rolls spans up into one row per trace, newest-first", () => {
    const spans = [
      span({ traceId: "t-old", startTime: 1_000 }),
      span({ traceId: "t-new", startTime: 5_000 }),
      span({ traceId: "t-new", spanId: "child", startTime: 5_100, operationName: "execute_tool" }),
    ]
    const { result } = renderHook(() => useTraceList({ spans }))
    expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-new", "t-old"])
    expect(result.current.traces[0].spanCount).toBe(2)
    expect(result.current.windowTotal).toBe(2)
  })

  it("filters errors across the whole window, not just the visible page", () => {
    const spans = [
      ...Array.from({ length: 60 }, (_, i) => span({ traceId: `ok-${i}`, startTime: 9_000 - i })),
      span({ traceId: "boom", startTime: 1, errorType: "ToolError" }),
    ]
    const { result } = renderHook(() => useTraceList({ spans, errorsOnly: true, pageSize: 50 }))
    // The failing trace is the oldest of 61 — page 2 under an unfiltered pager.
    expect(result.current.traces.map((r) => r.traceId)).toEqual(["boom"])
    expect(result.current.matchedTotal).toBe(1)
    expect(result.current.windowTotal).toBe(61)
  })

  it("matches the query against root name, trace id, and surface", () => {
    const spans = [
      span({ traceId: "aaa", operationName: "execute_tool", toolName: "Bash", startTime: 3 }),
      span({ traceId: "bbb", surface: "workflow", startTime: 2 }),
      span({ traceId: "ccc", startTime: 1 }),
    ]
    const byTool = renderHook(() => useTraceList({ spans, query: "bash" }))
    expect(byTool.result.current.traces.map((r) => r.traceId)).toEqual(["aaa"])

    const bySurface = renderHook(() => useTraceList({ spans, query: "workflow" }))
    expect(bySurface.result.current.traces.map((r) => r.traceId)).toEqual(["bbb"])

    const byId = renderHook(() => useTraceList({ spans, query: "ccc" }))
    expect(byId.result.current.traces.map((r) => r.traceId)).toEqual(["ccc"])
  })

  it("pages over the filtered set while `matched` keeps the whole of it", () => {
    const spans = Array.from({ length: 5 }, (_, i) =>
      span({ traceId: `t-${i}`, startTime: 100 - i })
    )
    const { result } = renderHook(() => useTraceList({ spans, pageSize: 2, page: 1 }))
    expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-2", "t-3"])
    expect(result.current.matched).toHaveLength(5)
    expect(result.current.pageCount).toBe(3)
    expect(result.current.page).toBe(1)
  })

  it("clamps a page index left stranded by a narrower filter", () => {
    const spans = Array.from({ length: 3 }, (_, i) =>
      span({ traceId: `t-${i}`, startTime: 100 - i })
    )
    const { result } = renderHook(() => useTraceList({ spans, pageSize: 2, page: 7 }))
    expect(result.current.page).toBe(1)
    expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-2"])
  })

  it("reports a single empty page rather than zero pages", () => {
    const { result } = renderHook(() => useTraceList({ spans: [] }))
    expect(result.current.pageCount).toBe(1)
    expect(result.current.matchedTotal).toBe(0)
    expect(result.current.loading).toBe(false)
  })

  it("re-uses the same rollup while the span array is identical", () => {
    const spans = [span({ traceId: "t-1" })]
    const { result, rerender } = renderHook(({ s }) => useTraceList({ spans: s }), {
      initialProps: { s: spans },
    })
    const first = result.current.matched
    rerender({ s: spans })
    expect(result.current.matched).toBe(first)
  })
})
