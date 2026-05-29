"use client"

/**
 * Single shared memo that turns the windowed spans into every derived series
 * the panels need — computed in one pass so panels don't each re-bucket.
 */

import { useMemo } from "react"
import {
  costSeries,
  errorRateSeries,
  latencyPercentileSeries,
  requestRateSeries,
  tokenSeries,
  windowKpis,
  type TimeSeries,
  type WindowKpis,
} from "@/lib/observability/aggregate-series"
import { breakdownBy, type BreakdownRow } from "@/lib/observability/breakdown"
import { rollupTraces, type TraceRollupRow } from "@/lib/observability/trace-rollup"
import { pickBucketMs, type TimeRange } from "@/lib/observability/time-range"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

export interface ObservabilitySeries {
  bucketMs: number
  cost: TimeSeries<"costUsd">
  tokens: TimeSeries<"input" | "output" | "cacheRead" | "cacheCreation">
  requestRate: TimeSeries<"count" | "perSec">
  errorRate: TimeSeries<"errors" | "total" | "errorRate">
  latency: TimeSeries<"p50" | "p95" | "p99">
  breakdownModel: BreakdownRow[]
  breakdownSurface: BreakdownRow[]
  breakdownOperation: BreakdownRow[]
  breakdownTool: BreakdownRow[]
  traces: TraceRollupRow[]
  kpis: WindowKpis
}

export function useObservabilitySeries(
  spans: AgentTraceSpan[],
  range: TimeRange
): ObservabilitySeries {
  return useMemo(() => {
    const bucketMs = pickBucketMs(range)
    return {
      bucketMs,
      cost: costSeries(spans, range, bucketMs),
      tokens: tokenSeries(spans, range, bucketMs),
      requestRate: requestRateSeries(spans, range, bucketMs),
      errorRate: errorRateSeries(spans, range, bucketMs),
      latency: latencyPercentileSeries(spans, range, bucketMs),
      breakdownModel: breakdownBy(spans, "model"),
      breakdownSurface: breakdownBy(spans, "surface"),
      breakdownOperation: breakdownBy(spans, "operation"),
      breakdownTool: breakdownBy(spans, "tool"),
      traces: rollupTraces(spans),
      kpis: windowKpis(spans, range),
    }
  }, [spans, range])
}
