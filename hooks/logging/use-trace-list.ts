"use client"

/**
 * useTraceList — the trace-list projection of the `/logs` Traces channel.
 *
 * Pure derivation over spans somebody else already read. The channel's single
 * Dexie window read lives in `useObservabilityData`, which the channel shares
 * with its Dashboard sub-view; this hook turns that array into the rollup, the
 * active list filter and the page.
 *
 * Why it does no I/O: the channel used to own a second windowed read here, and
 * before that a third in `AgentTraceStatsBar`'s live query. Every span that
 * landed re-read the identical window two or three times and folded it two or
 * three times, for one screen. One read, one fold, several projections — so
 * the list, the KPI panels and the charts can never disagree. The headline
 * aggregates it used to compute are `useObservabilitySeries`'s `kpis` now: the
 * stats bar they fed was a fifth rendering of numbers the KPI panels already
 * carry.
 *
 * Why a window rather than `queryRecentTraces(limit, offset)`: that helper
 * pages over raw trace order, so a filter could only ever narrow the page you
 * happened to be on — "show me only failed traces" would skip failures living
 * on page 2. Scoping to a window first makes the filters mean what they say.
 */

import { useMemo } from "react"

import { rollupTraces, type TraceRollupRow } from "@/lib/observability/trace-rollup"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const EMPTY_ROWS: TraceRollupRow[] = []

export const TRACE_PAGE_SIZE = 50

export interface UseTraceListOptions {
  /** Windowed + variable-filtered spans (from `useObservabilityData`). */
  spans: AgentTraceSpan[]
  /** True while the underlying window read is still in flight. */
  loading?: boolean
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
  /** Every trace left after `errorsOnly` / `query`, unpaged — what an export
   * of "the traces I am looking at" has to contain. */
  matched: TraceRollupRow[]
  /** Traces in the window before the list filters — the denominator users expect. */
  windowTotal: number
  /** Traces left after `errorsOnly` / `query`. */
  matchedTotal: number
  pageCount: number
  /** Clamped page index — the caller's `page` may be stale after a filter change. */
  page: number
  loading: boolean
}

function matches(row: TraceRollupRow, needle: string): boolean {
  return (
    row.rootName.toLowerCase().includes(needle) ||
    row.traceId.toLowerCase().includes(needle) ||
    row.surface.toLowerCase().includes(needle)
  )
}

export function useTraceList(options: UseTraceListOptions): UseTraceListResult {
  const { spans, loading = false, errorsOnly = false, query = "", page = 0 } = options
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? TRACE_PAGE_SIZE))

  const allTraces = useMemo(() => rollupTraces(spans), [spans])

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

  return {
    traces,
    matched: filtered,
    windowTotal: allTraces.length,
    matchedTotal: filtered.length,
    pageCount,
    page: safePage,
    loading,
  }
}

export default useTraceList
