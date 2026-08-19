"use client"

/**
 * useTraceList — the `/logs` Traces channel's data, from **one** window read.
 *
 * Reads a time window of persisted spans (`queryByWindow`, backed by the v150
 * global `startTime` index) and derives everything the channel needs from that
 * single array: the trace rollup, the active filter, the page, and the
 * headline cost/token/cache/error summary.
 *
 * Why one read: the channel used to pair this hook with `AgentTraceStatsBar`'s
 * own `aggregateStatsAll` live query. Both scanned the identical window, so
 * every span that landed re-read the same rows from IndexedDB twice and folded
 * them twice, for one screen. The stats bar now takes a summary prop and this
 * hook supplies it.
 *
 * Why a window rather than `queryRecentTraces(limit, offset)`: that helper
 * pages over raw trace order, so a filter could only ever narrow the page you
 * happened to be on — "show me only failed traces" would skip failures living
 * on page 2. Scoping to a window first makes the filters mean what they say.
 *
 * The read is capped (`SPAN_READ_CAP`). An "all time" window on a heavy
 * install is otherwise an unbounded materialization. When the cap bites, the
 * hook reports it — see `truncated` / `windowSpanCount` — so the UI can say so
 * instead of quietly showing a partial answer.
 */

import { useMemo } from "react"

import { useClientLiveQuery } from "@/hooks/data"
import {
  aggregateStats,
  countByWindow,
  queryByWindow,
  type AgentTraceStatsSummary,
} from "@/lib/db/agent-traces"
import { rollupTraces, type TraceRollupRow } from "@/lib/observability/trace-rollup"
import {
  agentTraceWindowSinceOrZero,
  type AgentTraceStatsWindow,
} from "@/lib/observability/trace-window"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const EMPTY_SPANS: AgentTraceSpan[] = []
const EMPTY_ROWS: TraceRollupRow[] = []

export const TRACE_PAGE_SIZE = 50

/** Newest-N ceiling on a single window read. */
export const SPAN_READ_CAP = 20_000

export interface UseTraceListOptions {
  /** Retention window shared with the stats bar. */
  window: AgentTraceStatsWindow
  /** Keep only traces with at least one failed span. */
  errorsOnly?: boolean
  /** Case-insensitive match on the root span name, trace id, or surface. */
  query?: string
  /** Zero-based page index. */
  page?: number
  pageSize?: number
}

export interface UseTraceListResult {
  /** The current page of traces, newest-first. */
  traces: TraceRollupRow[]
  /** Traces in the window before filtering — the denominator users expect. */
  windowTotal: number
  /** Traces left after `errorsOnly` / `query`. */
  matchedTotal: number
  pageCount: number
  /** Clamped page index — the caller's `page` may be stale after a filter change. */
  page: number
  loading: boolean
  /** Headline aggregates over the same spans, so the numbers can never disagree. */
  summary: AgentTraceStatsSummary | null
  /** Spans actually read. Equals `windowSpanCount` unless the cap bit. */
  spanCount: number
  /** Spans the window holds in total. */
  windowSpanCount: number
  /** True when the window is larger than `SPAN_READ_CAP`. */
  truncated: boolean
}

function matches(row: TraceRollupRow, needle: string): boolean {
  return (
    row.rootName.toLowerCase().includes(needle) ||
    row.traceId.toLowerCase().includes(needle) ||
    row.surface.toLowerCase().includes(needle)
  )
}

export function useTraceList(options: UseTraceListOptions): UseTraceListResult {
  const { window, errorsOnly = false, query = "", page = 0 } = options
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? TRACE_PAGE_SIZE))

  const since = useMemo(() => agentTraceWindowSinceOrZero(window), [window])

  const spans = useClientLiveQuery<AgentTraceSpan[]>(
    () => queryByWindow({ since, limit: SPAN_READ_CAP }),
    [since],
    EMPTY_SPANS
  )
  // Cheap key-only count, so "you are seeing the newest 20 000 of 61 004" is
  // available without a second materialization.
  const windowSpanCount = useClientLiveQuery<number>(() => countByWindow({ since }), [since], 0)

  const rows = spans ?? EMPTY_SPANS
  const allTraces = useMemo(() => rollupTraces(rows), [rows])
  const summary = useMemo(() => (spans === undefined ? null : aggregateStats(rows)), [spans, rows])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!errorsOnly && needle.length === 0) return allTraces
    return allTraces.filter(
      (row) => (!errorsOnly || row.errorCount > 0) && (needle.length === 0 || matches(row, needle))
    )
  }, [allTraces, errorsOnly, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(Math.max(0, Math.floor(page)), pageCount - 1)
  const traces = useMemo(
    () =>
      filtered.length === 0
        ? EMPTY_ROWS
        : filtered.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [filtered, safePage, pageSize]
  )

  const total = windowSpanCount ?? 0

  return {
    traces,
    windowTotal: allTraces.length,
    matchedTotal: filtered.length,
    pageCount,
    page: safePage,
    loading: spans === undefined,
    summary,
    spanCount: rows.length,
    windowSpanCount: total,
    truncated: total > rows.length,
  }
}

export default useTraceList
