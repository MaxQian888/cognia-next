"use client"

/**
 * Single shared memo that turns the windowed spans into every derived series
 * the panels need — computed in one pass so panels don't each re-bucket.
 *
 * The trace rollup is deliberately NOT here: `useTraceList` already folds the
 * same spans into `TraceRollupRow`s for the Explore list, and computing it
 * twice per render was the last duplicate fold left after the two surfaces
 * merged.
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
  /** Cost-attribution rollups (ADR-0130) — the `bd-provider` / `bd-project`
   * panels plotted the model rollup until these existed. */
  breakdownProvider: BreakdownRow[]
  breakdownProject: BreakdownRow[]
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
      breakdownProvider: breakdownBy(spans, "provider"),
      breakdownProject: breakdownBy(spans, "project"),
      kpis: windowKpis(spans, range),
    }
  }, [spans, range])
}
