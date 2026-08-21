/**
 * Time-series bucketing for the observability dashboard.
 *
 * Generalizes `computeVolumeBuckets` from `log-stats-dashboard.tsx` but uses
 * FIXED boundaries from `bucketBoundaries(range)` so empty leading/trailing
 * buckets still render (Grafana behavior) instead of snapping to the data
 * extent. All functions are pure; spans are assumed already windowed to the
 * range (out-of-range spans are skipped defensively).
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { bucketBoundaries, type TimeRange } from "./time-range"
import { percentilesOf } from "./percentiles"

/** A single x-axis sample. `t` is the bucket-start epoch ms. */
export interface SeriesPoint {
  t: number
}

export type TimeSeries<K extends string> = {
  points: (SeriesPoint & Record<K, number | null>)[]
}

function isError(span: AgentTraceSpan): boolean {
  return Boolean(span.errorType || span.errorMessage)
}

/**
 * Partition spans into buckets index-aligned to `bucketBoundaries`. Spans are
 * assigned by `startTime`. The returned array length === boundary count.
 */
export function bucketSpans(
  spans: AgentTraceSpan[],
  range: TimeRange,
  bucketMs: number
): AgentTraceSpan[][] {
  const boundaries = bucketBoundaries(range, bucketMs)
  const safeBucket = Math.max(1, Math.floor(bucketMs))
  const buckets: AgentTraceSpan[][] = boundaries.map(() => [])
  for (const s of spans) {
    const idx = Math.floor((s.startTime - range.since) / safeBucket)
    if (idx < 0 || idx >= buckets.length) continue
    buckets[idx].push(s)
  }
  return buckets
}

function build<K extends string>(
  spans: AgentTraceSpan[],
  range: TimeRange,
  bucketMs: number,
  project: (bucket: AgentTraceSpan[]) => Record<K, number | null>
): TimeSeries<K> {
  const boundaries = bucketBoundaries(range, bucketMs)
  const buckets = bucketSpans(spans, range, bucketMs)
  return {
    points: boundaries.map((t, i) => ({ t, ...project(buckets[i]) })),
  }
}

/** Total estimated USD cost per bucket. */
export function costSeries(
  spans: AgentTraceSpan[],
  range: TimeRange,
  bucketMs: number
): TimeSeries<"costUsd"> {
  return build(spans, range, bucketMs, (bucket) => ({
    costUsd: bucket.reduce((sum, s) => sum + (s.costUsdEstimate ?? 0), 0),
  }))
}

/** Token throughput per bucket, split by token class. */
export function tokenSeries(
  spans: AgentTraceSpan[],
  range: TimeRange,
  bucketMs: number
): TimeSeries<"input" | "output" | "cacheRead" | "cacheCreation"> {
  return build(spans, range, bucketMs, (bucket) => {
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheCreation = 0
    for (const s of bucket) {
      if (!s.usage) continue
      input += s.usage.inputTokens
      output += s.usage.outputTokens
      cacheRead += s.usage.cacheReadTokens
      cacheCreation += s.usage.cacheCreationTokens
    }
    return { input, output, cacheRead, cacheCreation }
  })
}

/** Span (request) count and rate (per second) per bucket. */
export function requestRateSeries(
  spans: AgentTraceSpan[],
  range: TimeRange,
  bucketMs: number
): TimeSeries<"count" | "perSec"> {
  const perBucketSec = Math.max(1, bucketMs) / 1000
  return build(spans, range, bucketMs, (bucket) => ({
    count: bucket.length,
    perSec: bucket.length / perBucketSec,
  }))
}

/** Error count, total, and rate (fraction 0..1) per bucket. Rate is null for
 * empty buckets so the line shows a gap rather than a misleading 0%. */
export function errorRateSeries(
  spans: AgentTraceSpan[],
  range: TimeRange,
  bucketMs: number
): TimeSeries<"errors" | "total" | "errorRate"> {
  return build(spans, range, bucketMs, (bucket) => {
    const total = bucket.length
    const errors = bucket.reduce((n, s) => n + (isError(s) ? 1 : 0), 0)
    return { errors, total, errorRate: total > 0 ? errors / total : null }
  })
}

/** p50/p95/p99 latency (ms) per bucket. Null for empty buckets (line gap). */
export function latencyPercentileSeries(
  spans: AgentTraceSpan[],
  range: TimeRange,
  bucketMs: number
): TimeSeries<"p50" | "p95" | "p99"> {
  return build(spans, range, bucketMs, (bucket) => {
    const durations = bucket
      .map((s) => s.durationMs)
      .filter((d): d is number => typeof d === "number")
    if (durations.length === 0) return { p50: null, p95: null, p99: null }
    const [p50, p95, p99] = percentilesOf(durations, [0.5, 0.95, 0.99])
    return { p50, p95, p99 }
  })
}

/** Headline KPIs for the stat row over the whole window. */
export interface WindowKpis {
  totalCost: number
  totalSpans: number
  /** fraction 0..1 over the window */
  errorRate: number
  /** fraction 0..1; cacheRead / (input + cacheRead) */
  cacheHitRate: number
  p95LatencyMs: number
  reqPerMin: number
  /** Spans whose operation is `execute_tool`. */
  toolCalls: number
  /** Of those, how many carried an error. */
  toolFailures: number
}

export function windowKpis(spans: AgentTraceSpan[], range: TimeRange): WindowKpis {
  let totalCost = 0
  let errors = 0
  let input = 0
  let cacheRead = 0
  let toolCalls = 0
  let toolFailures = 0
  const durations: number[] = []
  for (const s of spans) {
    totalCost += s.costUsdEstimate ?? 0
    const failed = isError(s)
    if (failed) errors += 1
    // Same rule as `lib/db/agent-traces.ts:aggregate` — a tool call is an
    // `execute_tool` span, so the two surfaces can never disagree on the count.
    if (s.operationName === "execute_tool") {
      toolCalls += 1
      if (failed) toolFailures += 1
    }
    if (s.usage) {
      input += s.usage.inputTokens
      cacheRead += s.usage.cacheReadTokens
    }
    if (typeof s.durationMs === "number") durations.push(s.durationMs)
  }
  const total = spans.length
  const cacheable = input + cacheRead
  const spanMinutes = Math.max(1 / 60, (range.until - range.since) / 60_000)
  return {
    totalCost,
    totalSpans: total,
    errorRate: total > 0 ? errors / total : 0,
    cacheHitRate: cacheable > 0 ? cacheRead / cacheable : 0,
    p95LatencyMs: percentilesOf(durations, [0.95])[0],
    reqPerMin: total / spanMinutes,
    toolCalls,
    toolFailures,
  }
}
