"use client"

/**
 * Lazily loads one trace's spans (only when a trace is selected) and builds
 * the waterfall tree for the drill-down drawer.
 */

import { useMemo } from "react"
import { useClientLiveQuery } from "@/hooks/data"
import { queryByTrace } from "@/lib/db/agent-traces"
import { buildWaterfall, type Waterfall } from "@/lib/observability/trace-rollup"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const EMPTY: AgentTraceSpan[] = []

export interface TraceDetail {
  waterfall: Waterfall
  loading: boolean
}

export function useTraceDetail(traceId: string | null): TraceDetail {
  const spans = useClientLiveQuery<AgentTraceSpan[]>(
    () => (traceId ? queryByTrace(traceId) : Promise.resolve(EMPTY)),
    [traceId],
    EMPTY
  )

  const waterfall = useMemo(() => buildWaterfall(spans ?? EMPTY), [spans])

  return { waterfall, loading: Boolean(traceId) && spans === undefined }
}
