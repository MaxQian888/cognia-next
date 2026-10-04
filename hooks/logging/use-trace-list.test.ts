/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import type { AgentTraceSpan } from "@/types/agent-trace/span"

// The list must search through the channel's ONE matcher (shared with the
// timeline); wrap it so the test can see what the list asks of it.
jest.mock("@/lib/observability/trace-search", () => {
  const actual = jest.requireActual("@/lib/observability/trace-search")
  return {
    ...actual,
    matchesTraceQuery: jest.fn(actual.matchesTraceQuery),
    normalizeTraceQuery: jest.fn(actual.normalizeTraceQuery),
  }
})

import { matchesTraceQuery, normalizeTraceQuery } from "@/lib/observability/trace-search"
import { TRACE_PAGE_SIZE, useTraceList } from "./use-trace-list"

const matchesMock = matchesTraceQuery as jest.MockedFunction<typeof matchesTraceQuery>
const normalizeMock = normalizeTraceQuery as jest.MockedFunction<typeof normalizeTraceQuery>

beforeEach(() => {
  matchesMock.mockClear()
  normalizeMock.mockClear()
})

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

  it("defaults to 50 traces per page", () => {
    expect(TRACE_PAGE_SIZE).toBe(50)
    const spans = Array.from({ length: 51 }, (_, i) =>
      span({ traceId: `t-${i}`, startTime: 1_000 - i })
    )
    const { result } = renderHook(() => useTraceList({ spans }))
    expect(result.current.traces).toHaveLength(50)
    expect(result.current.pageCount).toBe(2)
  })

  describe("search", () => {
    it("asks the shared matcher about root name, trace id and surface", () => {
      const spans = [span({ traceId: "aaa", surface: "workflow", operationName: "chat" })]
      renderHook(() => useTraceList({ spans, query: "  WorkFlow " }))
      expect(normalizeMock).toHaveBeenCalledWith("  WorkFlow ")
      expect(matchesMock).toHaveBeenCalledWith(
        { name: expect.any(String), traceId: "aaa", surface: "workflow" },
        "workflow"
      )
    })

    it("matches the surface case-insensitively after trimming", () => {
      const spans = [
        span({ traceId: "aaa", surface: "agent-team", startTime: 2 }),
        span({ traceId: "bbb", surface: "chat", startTime: 1 }),
      ]
      const { result } = renderHook(() => useTraceList({ spans, query: "  AGENT-team  " }))
      expect(result.current.matched.map((r) => r.traceId)).toEqual(["aaa"])
    })

    it("skips the matcher entirely for a blank query", () => {
      const spans = [span({ traceId: "aaa" })]
      const { result } = renderHook(() => useTraceList({ spans, query: "   " }))
      expect(matchesMock).not.toHaveBeenCalled()
      expect(result.current.matchedTotal).toBe(1)
    })

    it("combines errors-only and search", () => {
      const spans = [
        span({ traceId: "bash-ok", toolName: "Bash", operationName: "execute_tool", startTime: 3 }),
        span({
          traceId: "bash-bad",
          toolName: "Bash",
          operationName: "execute_tool",
          errorType: "ToolError",
          startTime: 2,
        }),
        span({ traceId: "read-bad", toolName: "Read", errorType: "ToolError", startTime: 1 }),
      ]
      const { result } = renderHook(() => useTraceList({ spans, query: "bash", errorsOnly: true }))
      expect(result.current.matched.map((r) => r.traceId)).toEqual(["bash-bad"])
    })
  })

  describe("all", () => {
    it("is every trace in the window, ignoring search, errors-only and freeze", () => {
      const spans = [
        span({ traceId: "new", startTime: 300 }),
        span({ traceId: "bad", startTime: 200, errorType: "ToolError" }),
        span({ traceId: "old", startTime: 100 }),
      ]
      const { result } = renderHook(() =>
        useTraceList({ spans, errorsOnly: true, query: "bad", freezeAfter: 150 })
      )
      expect(result.current.all.map((r) => r.traceId)).toEqual(["new", "bad", "old"])
      expect(result.current.windowTotal).toBe(3)
      // The freeze holds "bad" back (it started after 150), so nothing is listed.
      expect(result.current.matched).toEqual([])
      expect(result.current.pendingCount).toBe(1)
    })
  })

  describe("freeze", () => {
    const spans = [
      span({ traceId: "t-new", startTime: 500 }),
      span({ traceId: "t-mid", startTime: 300 }),
      span({ traceId: "t-old", startTime: 100 }),
    ]

    it("holds back traces that started after the cutoff and counts them", () => {
      const { result } = renderHook(() => useTraceList({ spans, freezeAfter: 300 }))
      expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-mid", "t-old"])
      expect(result.current.matchedTotal).toBe(2)
      expect(result.current.pendingCount).toBe(1)
      expect(result.current.windowTotal).toBe(3)
    })

    it("keeps a trace that started exactly at the cutoff", () => {
      const { result } = renderHook(() => useTraceList({ spans, freezeAfter: 500 }))
      expect(result.current.pendingCount).toBe(0)
      expect(result.current.matchedTotal).toBe(3)
    })

    it("only counts held-back traces that pass the list filters", () => {
      const withError = [
        ...spans,
        span({ traceId: "t-new-bad", startTime: 600, errorType: "ToolError" }),
        span({ traceId: "t-old-bad", startTime: 50, errorType: "ToolError" }),
      ]
      const { result } = renderHook(() =>
        useTraceList({ spans: withError, freezeAfter: 300, errorsOnly: true })
      )
      expect(result.current.matched.map((r) => r.traceId)).toEqual(["t-old-bad"])
      expect(result.current.pendingCount).toBe(1)
    })

    it("is off for null or a non-finite cutoff", () => {
      for (const freezeAfter of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
        const { result } = renderHook(() => useTraceList({ spans, freezeAfter }))
        expect(result.current.pendingCount).toBe(0)
        expect(result.current.matchedTotal).toBe(3)
      }
    })

    it("pins every listed row while new traces arrive", () => {
      const { result, rerender } = renderHook(
        ({ s }) => useTraceList({ spans: s, freezeAfter: 500 }),
        {
          initialProps: { s: spans },
        }
      )
      const before = result.current.traces.map((r) => r.traceId)
      rerender({ s: [...spans, span({ traceId: "t-newer", startTime: 900 })] })
      expect(result.current.traces.map((r) => r.traceId)).toEqual(before)
      expect(result.current.pendingCount).toBe(1)
    })
  })

  describe("newestStart", () => {
    it("is the start of the newest LISTED trace", () => {
      const spans = [span({ traceId: "a", startTime: 500 }), span({ traceId: "b", startTime: 300 })]
      expect(renderHook(() => useTraceList({ spans })).result.current.newestStart).toBe(500)
      // Held-back traces do not move the cutoff.
      expect(
        renderHook(() => useTraceList({ spans, freezeAfter: 400 })).result.current.newestStart
      ).toBe(300)
    })

    it("is null when nothing is listed", () => {
      expect(renderHook(() => useTraceList({ spans: [] })).result.current.newestStart).toBeNull()
    })
  })

  describe("selection", () => {
    const spans = Array.from({ length: 7 }, (_, i) =>
      span({ traceId: `t-${i}`, startTime: 1_000 - i })
    )

    it("reports the selected trace's position in the listed set", () => {
      const { result } = renderHook(() =>
        useTraceList({ spans, pageSize: 3, selectedTraceId: "t-4" })
      )
      expect(result.current.selectedIndex).toBe(4)
      // An explicit page is not overridden by the selection.
      expect(result.current.page).toBe(0)
    })

    it("follows the selection to its page when page is null", () => {
      const { result } = renderHook(() =>
        useTraceList({ spans, pageSize: 3, page: null, selectedTraceId: "t-4" })
      )
      expect(result.current.page).toBe(1)
      expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-3", "t-4", "t-5"])
    })

    it("follows the selection to the last page", () => {
      const { result } = renderHook(() =>
        useTraceList({ spans, pageSize: 3, page: null, selectedTraceId: "t-6" })
      )
      expect(result.current.page).toBe(2)
      expect(result.current.traces.map((r) => r.traceId)).toEqual(["t-6"])
    })

    it("falls back to the first page when page is null and nothing is selected", () => {
      const { result } = renderHook(() => useTraceList({ spans, pageSize: 3, page: null }))
      expect(result.current.page).toBe(0)
      expect(result.current.selectedIndex).toBe(-1)
    })

    it("is -1 when the selection is outside the window", () => {
      const { result } = renderHook(() =>
        useTraceList({ spans, pageSize: 3, page: null, selectedTraceId: "gone" })
      )
      expect(result.current.selectedIndex).toBe(-1)
      expect(result.current.page).toBe(0)
    })

    it("is -1 when a list filter hides the selection", () => {
      const { result } = renderHook(() =>
        useTraceList({ spans, selectedTraceId: "t-2", errorsOnly: true })
      )
      expect(result.current.selectedIndex).toBe(-1)
    })

    it("is -1 when the freeze holds the selection back", () => {
      const { result } = renderHook(() =>
        useTraceList({ spans, selectedTraceId: "t-0", freezeAfter: 999 })
      )
      expect(result.current.selectedIndex).toBe(-1)
      expect(result.current.pendingCount).toBe(1)
    })
  })
})
