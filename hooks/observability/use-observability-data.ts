"use client"

/**
 * Windowed, filtered span source for the `/logs` Traces channel — the single
 * Dexie read behind BOTH of its sub-views. Reads persisted spans in
 * `[range.since, range.until]` via Dexie `useLiveQuery` (so any new span lands
 * within the transport's ~1s flush) and applies the variable filters
 * client-side.
 *
 * `tick` participates in the query deps so relative time windows re-fetch as
 * the wall clock advances even when the table is otherwise idle.
 *
 * The read is capped at {@link SPAN_READ_CAP} newest spans. A 30-day window on
 * a heavy install is otherwise an unbounded materialization, and the dashboard
 * and the trace list now share this one array — paying for it twice was the
 * old shape. When the cap bites the hook says so (`truncated`,
 * `windowSpanCount`) rather than quietly showing a partial answer.
 *
 * A failed read is caught INSIDE the live query and reported as `error`, with
 * `retry()` to run it again. `useLiveQuery` rethrows a rejected query during
 * render, which would have taken the whole `/logs` page down to its error
 * boundary for what is usually a transient IndexedDB hiccup (a blocked
 * upgrade, a quota spike); left uncaught the other way it read as "loading"
 * forever. Both sub-views render the error with a Retry button instead.
 */

import { useCallback, useMemo, useState } from "react"
import { useClientLiveQuery } from "@/hooks/data"
import { countByWindow, queryByWindow } from "@/lib/db/agent-traces"
import { applyFilters, type TraceFilters } from "@/lib/observability/filters"
import type { TimeRange } from "@/lib/observability/time-range"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const EMPTY: AgentTraceSpan[] = []

/** Newest-N ceiling on a single window read. */
export const SPAN_READ_CAP = 20_000

export interface ObservabilityData {
  /** Windowed + filtered spans (oldest-first). */
  spans: AgentTraceSpan[]
  /** Spans before filtering — used to populate filter-bar option lists. */
  windowSpans: AgentTraceSpan[]
  loading: boolean
  /** Spans actually read. Equals `windowSpanCount` unless the cap bit. */
  spanCount: number
  /** Spans the window holds in total, counted without materializing them. */
  windowSpanCount: number
  /** True when the window is larger than {@link SPAN_READ_CAP}. */
  truncated: boolean
  /** The window read failed; `null` while it succeeds or is in flight. */
  error: Error | null
  /** Run the window read again (after a failure, typically). */
  retry: () => void
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; error: Error }

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** Wrap a read so a rejection becomes data instead of a render-time throw. */
async function settle<T>(read: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (cause) {
    return { ok: false, error: toError(cause) }
  }
}

export interface UseObservabilityDataOptions {
  /** Override the read cap. Exists for tests — production wants {@link SPAN_READ_CAP}. */
  limit?: number
}

export function useObservabilityData(
  range: TimeRange,
  filters: TraceFilters,
  tick: number,
  options: UseObservabilityDataOptions = {}
): ObservabilityData {
  const limit =
    typeof options.limit === "number" && options.limit > 0 ? options.limit : SPAN_READ_CAP
  // Bumped by `retry()`; a dep of both reads so they re-run on demand.
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const read = useClientLiveQuery<ReadResult<AgentTraceSpan[]>>(
    () => settle(() => queryByWindow({ since: range.since, until: range.until, limit })),
    [range.since, range.until, tick, limit, attempt],
    { ok: true, value: EMPTY }
  )
  // Cheap key-only count, so "you are seeing the newest 20 000 of 61 004" is
  // available without a second materialization.
  const counted = useClientLiveQuery<ReadResult<number>>(
    () => settle(() => countByWindow({ since: range.since, until: range.until })),
    [range.since, range.until, tick, attempt],
    { ok: true, value: 0 }
  )

  const windowSpans = read === undefined ? undefined : read.ok ? read.value : EMPTY
  const windowSpanCount = counted?.ok ? counted.value : 0
  const error = read && !read.ok ? read.error : counted && !counted.ok ? counted.error : null

  const rows = windowSpans ?? EMPTY
  const spans = useMemo(
    () => (windowSpans ? applyFilters(windowSpans, filters) : EMPTY),
    [windowSpans, filters]
  )

  const total = windowSpanCount ?? 0

  return {
    spans,
    windowSpans: rows,
    loading: read === undefined,
    spanCount: rows.length,
    windowSpanCount: total,
    truncated: total > rows.length,
    error,
    retry,
  }
}
