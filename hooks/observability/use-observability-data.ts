"use client"

/**
 * Windowed, filtered span source for the dashboard. Reads persisted spans in
 * `[range.since, range.until]` via Dexie `useLiveQuery` (so any new span lands
 * within the transport's ~1s flush) and applies the variable filters
 * client-side.
 *
 * `tick` participates in the query deps so relative time windows re-fetch as
 * the wall clock advances even when the table is otherwise idle.
 */

import { useMemo } from "react"
import { useClientLiveQuery } from "@/hooks/data"
import { queryByWindow } from "@/lib/db/agent-traces"
import { applyFilters, type TraceFilters } from "@/lib/observability/filters"
import type { TimeRange } from "@/lib/observability/time-range"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const EMPTY: AgentTraceSpan[] = []

export interface ObservabilityData {
  /** Windowed + filtered spans (oldest-first). */
  spans: AgentTraceSpan[]
  /** Spans before filtering — used to populate filter-bar option lists. */
  windowSpans: AgentTraceSpan[]
  loading: boolean
}

export function useObservabilityData(
  range: TimeRange,
  filters: TraceFilters,
  tick: number
): ObservabilityData {
  const windowSpans = useClientLiveQuery<AgentTraceSpan[]>(
    () => queryByWindow({ since: range.since, until: range.until }),
    [range.since, range.until, tick],
    EMPTY
  )

  const spans = useMemo(
    () => (windowSpans ? applyFilters(windowSpans, filters) : EMPTY),
    [windowSpans, filters]
  )

  return {
    spans,
    windowSpans: windowSpans ?? EMPTY,
    loading: windowSpans === undefined,
  }
}
