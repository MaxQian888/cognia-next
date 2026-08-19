/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import type { AgentTraceSpan } from "@/types/agent-trace/span"

const queryByWindow = jest.fn<
  Promise<AgentTraceSpan[]>,
  [{ since: number; until?: number; limit?: number }]
>()
const countByWindow = jest.fn<Promise<number>, [{ since: number }]>()
const aggregateStats = jest.fn((spans: AgentTraceSpan[]) => ({ totalSpans: spans.length }))
jest.mock("@/lib/db/agent-traces", () => ({
  queryByWindow: (opts: { since: number; until?: number; limit?: number }) => queryByWindow(opts),
  countByWindow: (opts: { since: number }) => countByWindow(opts),
  aggregateStats: (spans: AgentTraceSpan[]) => aggregateStats(spans),
}))

// `useClientLiveQuery` is a thin Dexie wrapper; drive it synchronously so the
// hook's pure filter/page math is what's under test.
let liveResult: AgentTraceSpan[] | undefined
let liveCount = 0
// The hook runs two live queries: the window read and a key-only count. The
// stub distinguishes them by the shape the query resolves to.
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => Promise<unknown>, _deps: unknown[], initial: unknown) => {
    void query()
    return typeof initial === "number" ? liveCount : liveResult
  },
}))

import { SPAN_READ_CAP, useTraceList } from "./use-trace-list"

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

beforeEach(() => {
  queryByWindow.mockReset()
  queryByWindow.mockResolvedValue([])
  countByWindow.mockReset()
  countByWindow.mockResolvedValue(0)
  aggregateStats.mockClear()
  liveResult = []
  liveCount = 0
})

describe("useTraceList", () => {
  it("reports loading until the live query resolves", () => {
    liveResult = undefined
    const { result } = renderHook(() => useTraceList({ window: "today" }))
    expect(result.current.loading).toBe(true)
    expect(result.current.traces).toEqual([])
  })

  it("reads the window implied by the preset, under a cap", () => {
    renderHook(() => useTraceList({ window: "all" }))
    expect(queryByWindow).toHaveBeenCalledWith({ since: 0, limit: SPAN_READ_CAP })
  })

  it("derives the headline summary from the same rows as the list", () => {
    liveResult = [
      span({ traceId: "t-1", startTime: 1 }),
      span({ traceId: "t-2", spanId: "b", startTime: 2 }),
    ]
    const { result } = renderHook(() => useTraceList({ window: "today" }))
    // One window read; the summary is folded from its result, not re-queried.
    expect(queryByWindow).toHaveBeenCalledTimes(1)
    expect(aggregateStats).toHaveBeenCalledWith(liveResult)
    expect(result.current.summary).toEqual({ totalSpans: 2 })
  })

  it("holds the summary back until the read resolves", () => {
    liveResult = undefined
    const { result } = renderHook(() => useTraceList({ window: "today" }))
    expect(result.current.summary).toBeNull()
  })

  it("reports a capped read rather than silently showing a partial window", () => {
    liveResult = [span({ traceId: "t-1" })]
    liveCount = 61_004
    const { result } = renderHook(() => useTraceList({ window: "all" }))
    expect(result.current.truncated).toBe(true)
    expect(result.current.spanCount).toBe(1)
    expect(result.current.windowSpanCount).toBe(61_004)
  })

  it("is not truncated when the window fits under the cap", () => {
    liveResult = [span({ traceId: "t-1" }), span({ traceId: "t-2", spanId: "b" })]
    liveCount = 2
    const { result } = renderHook(() => useTraceList({ window: "today" }))
    expect(result.current.truncated).toBe(false)
  })

  it("rolls spans up into one row per trace, newest-first", () => {
    liveResult = [
      span({ traceId: "t-old", startTime: 1_000 }),
      span({ traceId: "t-new", startTime: 5_000 }),
      span({ traceId: "t-new", spanId: "child", startTime: 5_100, operationName: "execute_tool" }),
    ]
    const { result } = renderHook(() => useTraceList({ window: "today" }))
    expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-new", "t-old"])
    expect(result.current.traces[0].spanCount).toBe(2)
    expect(result.current.windowTotal).toBe(2)
  })

  it("filters errors across the whole window, not just the visible page", () => {
    liveResult = [
      ...Array.from({ length: 60 }, (_, i) => span({ traceId: `ok-${i}`, startTime: 9_000 - i })),
      span({ traceId: "boom", startTime: 1, errorType: "ToolError" }),
    ]
    const { result } = renderHook(() =>
      useTraceList({ window: "today", errorsOnly: true, pageSize: 50 })
    )
    // The failing trace is the oldest of 61 — page 2 under an unfiltered pager.
    expect(result.current.traces.map((r) => r.traceId)).toEqual(["boom"])
    expect(result.current.matchedTotal).toBe(1)
    expect(result.current.windowTotal).toBe(61)
  })

  it("matches the query against root name, trace id, and surface", () => {
    liveResult = [
      span({ traceId: "aaa", operationName: "execute_tool", toolName: "Bash", startTime: 3 }),
      span({ traceId: "bbb", surface: "workflow", startTime: 2 }),
      span({ traceId: "ccc", startTime: 1 }),
    ]
    const byTool = renderHook(() => useTraceList({ window: "today", query: "bash" }))
    expect(byTool.result.current.traces.map((r) => r.traceId)).toEqual(["aaa"])

    const bySurface = renderHook(() => useTraceList({ window: "today", query: "workflow" }))
    expect(bySurface.result.current.traces.map((r) => r.traceId)).toEqual(["bbb"])

    const byId = renderHook(() => useTraceList({ window: "today", query: "ccc" }))
    expect(byId.result.current.traces.map((r) => r.traceId)).toEqual(["ccc"])
  })

  it("pages over the filtered set", () => {
    liveResult = Array.from({ length: 5 }, (_, i) =>
      span({ traceId: `t-${i}`, startTime: 100 - i })
    )
    const { result } = renderHook(() => useTraceList({ window: "today", pageSize: 2, page: 1 }))
    expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-2", "t-3"])
    expect(result.current.pageCount).toBe(3)
    expect(result.current.page).toBe(1)
  })

  it("clamps a page index left stranded by a narrower filter", () => {
    liveResult = Array.from({ length: 3 }, (_, i) =>
      span({ traceId: `t-${i}`, startTime: 100 - i })
    )
    const { result } = renderHook(() => useTraceList({ window: "today", pageSize: 2, page: 7 }))
    expect(result.current.page).toBe(1)
    expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-2"])
  })

  it("reports a single empty page rather than zero pages", () => {
    liveResult = []
    const { result } = renderHook(() => useTraceList({ window: "today" }))
    expect(result.current.pageCount).toBe(1)
    expect(result.current.matchedTotal).toBe(0)
    expect(result.current.loading).toBe(false)
  })
})
