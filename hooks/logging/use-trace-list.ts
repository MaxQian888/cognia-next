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
 *
 * Two behaviours keep auto-refresh from moving the list under the user:
 *
 *  - **Freeze.** With `freezeAfter` set, traces that started after that cutoff
 *    are held back and only COUNTED (`pendingCount`), so the caller can offer
 *    "N new traces — show" instead of shoving every row down a slot each tick.
 *    The list is newest-first by start time, so new arrivals only ever land
 *    at the top; holding them back is enough to pin every row's position. (A
 *    sliding relative window still drops the oldest traces off the END, which
 *    moves nothing above them.) The caller decides when to freeze — on page
 *    2+, or while a trace is selected.
 *  - **Follow the selection.** `page: null` means "whichever page holds
 *    `selectedTraceId`", so a deep-linked trace on page 4 is revealed instead
 *    of leaving page 1 on screen with no row highlighted. `selectedIndex` is
 *    `-1` when the selection is not in the list at all — outside the window,
 *    hidden by a filter, or gone — which the caller flags.
 */

import { useMemo } from "react"

import { rollupTraces, type TraceRollupRow } from "@/lib/observability/trace-rollup"
import { matchesTraceQuery, normalizeTraceQuery } from "@/lib/observability/trace-search"
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
  /** Zero-based page index; `null` follows `selectedTraceId` (see header). */
  page?: number | null
  pageSize?: number
  /** The trace selected in the channel, if any. */
  selectedTraceId?: string | null
  /** Hold back traces that started after this epoch ms (see header). */
  freezeAfter?: number | null
}

export interface UseTraceListResult {
  /** The current page of traces, newest-first. */
  traces: TraceRollupRow[]
  /** Every trace left after `errorsOnly` / `query`, unpaged — what an export
   * of "the traces I am looking at" has to contain. Excludes held-back
   * traces, so it is exactly the list on screen. */
  matched: TraceRollupRow[]
  /** Every trace in the window under the variable filters only — no search,
   * no errors-only, no freeze. What the Dashboard (which has neither control)
   * is showing, and therefore what ITS export contains. */
  all: TraceRollupRow[]
  /** Traces in the window before the list filters — the denominator users expect. */
  windowTotal: number
  /** Traces left after `errorsOnly` / `query`. */
  matchedTotal: number
  pageCount: number
  /** Clamped page index — the caller's `page` may be stale after a filter change. */
  page: number
  loading: boolean
  /** Traces held back by `freezeAfter` that would otherwise be listed. */
  pendingCount: number
  /** Newest start time among listed traces — the cutoff a freeze should pin. */
  newestStart: number | null
  /** Position of `selectedTraceId` in `matched`, or -1. */
  selectedIndex: number
}

export function useTraceList(options: UseTraceListOptions): UseTraceListResult {
  const {
    spans,
    loading = false,
    errorsOnly = false,
    query = "",
    page = 0,
    selectedTraceId = null,
    freezeAfter = null,
  } = options
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? TRACE_PAGE_SIZE))

  const allTraces = useMemo(() => rollupTraces(spans), [spans])

  const listed = useMemo(() => {
    const needle = normalizeTraceQuery(query)
    if (!errorsOnly && needle.length === 0) return allTraces
    return allTraces.filter(
      (row) =>
        (!errorsOnly || row.errorCount > 0) &&
        matchesTraceQuery(
          { name: row.rootName, traceId: row.traceId, surface: row.surface },
          needle
        )
    )
  }, [allTraces, errorsOnly, query])

  const { filtered, pendingCount } = useMemo(() => {
    if (freezeAfter === null || !Number.isFinite(freezeAfter)) {
      return { filtered: listed, pendingCount: 0 }
    }
    const kept = listed.filter((row) => row.startTime <= freezeAfter)
    return { filtered: kept, pendingCount: listed.length - kept.length }
  }, [listed, freezeAfter])

  const selectedIndex = useMemo(
    () => (selectedTraceId ? filtered.findIndex((row) => row.traceId === selectedTraceId) : -1),
    [filtered, selectedTraceId]
  )

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const requestedPage =
    page === null ? (selectedIndex >= 0 ? Math.floor(selectedIndex / pageSize) : 0) : page
  const safePage = Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1)
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
    all: allTraces,
    windowTotal: allTraces.length,
    matchedTotal: filtered.length,
    pageCount,
    page: safePage,
    loading,
    pendingCount,
    newestStart: filtered.length > 0 ? filtered[0].startTime : null,
    selectedIndex,
  }
}

export default useTraceList
