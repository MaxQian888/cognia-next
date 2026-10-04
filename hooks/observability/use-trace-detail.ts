"use client"

/**
 * Lazily loads one trace's spans (only when a trace is selected) and builds
 * the waterfall tree for the Explore sub-view's detail panes.
 *
 * `notFound` is the distinct "this id has no persisted spans" answer — a
 * deep link to a trace that was pruned, cleared, or never existed. The pane
 * used to render the same "no persisted spans" line it shows for an empty
 * trace, with no way out but finding the right row by hand; the channel now
 * says "Trace not found" and offers to clear the selection.
 *
 * A failed read is reported as `error` (with `retry()`), for the same reason
 * `useObservabilityData` does: `useLiveQuery` would otherwise rethrow it into
 * render and take the page down.
 */

import { useCallback, useMemo, useState } from "react"
import { useClientLiveQuery } from "@/hooks/data"
import { queryByTrace } from "@/lib/db/agent-traces"
import { buildWaterfall, type Waterfall } from "@/lib/observability/trace-rollup"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const EMPTY: AgentTraceSpan[] = []

type DetailRead = { ok: true; spans: AgentTraceSpan[] } | { ok: false; error: Error }

export interface TraceDetail {
  waterfall: Waterfall
  loading: boolean
  /** A trace id is selected, the read finished, and it holds no spans. */
  notFound: boolean
  error: Error | null
  retry: () => void
}

export function useTraceDetail(traceId: string | null): TraceDetail {
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const read = useClientLiveQuery<DetailRead>(
    async () => {
      if (!traceId) return { ok: true, spans: EMPTY }
      try {
        return { ok: true, spans: await queryByTrace(traceId) }
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause : new Error(String(cause)) }
      }
    },
    [traceId, attempt],
    { ok: true, spans: EMPTY }
  )

  const spans = read?.ok ? read.spans : EMPTY
  const waterfall = useMemo(() => buildWaterfall(spans), [spans])
  const loading = Boolean(traceId) && read === undefined
  const error = read && !read.ok ? read.error : null

  return {
    waterfall,
    loading,
    notFound: Boolean(traceId) && !loading && error === null && spans.length === 0,
    error,
    retry,
  }
}
