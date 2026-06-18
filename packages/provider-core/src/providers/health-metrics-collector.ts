/**
 * Pure sliding-window health-metrics collector for providers.
 *
 * Shapes (`SlidingWindowBucket`, `ProviderHealthMetrics`, `MetricsRecord`,
 * config) live in `types/provider/health-metrics.ts`; this is the bucketing +
 * aggregation logic the store drives. Pure so it unit-tests deterministically.
 */

import {
  type HealthMetricsConfig,
  type MetricsRecord,
  type ProviderHealthMetrics,
  type SlidingWindowBucket,
} from "@/types/provider/health-metrics"

function bucketStart(ts: number, durationMs: number): number {
  return Math.floor(ts / durationMs) * durationMs
}

/** Nearest-rank percentile over a pre-sortable list (0..1 quantile). */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[idx]
}

/**
 * Fold a completed-request record into the bucket list, pruning buckets that
 * have aged out of the retention window. Returns a new, time-sorted array.
 */
export function recordToBuckets(
  buckets: SlidingWindowBucket[],
  record: MetricsRecord,
  config: HealthMetricsConfig,
  now: number
): SlidingWindowBucket[] {
  const ts = record.timestamp ?? now
  const start = bucketStart(ts, config.bucketDurationMs)

  const existing = buckets.find((b) => b.timestamp === start)
  const base: SlidingWindowBucket = existing ?? {
    timestamp: start,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    latencySum: 0,
    latencies: [],
    costSum: 0,
  }

  const updated: SlidingWindowBucket = {
    ...base,
    requestCount: base.requestCount + 1,
    successCount: base.successCount + (record.success ? 1 : 0),
    errorCount: base.errorCount + (record.success ? 0 : 1),
    latencySum: base.latencySum + record.latencyMs,
    latencies:
      base.latencies.length < config.maxLatenciesPerBucket
        ? [...base.latencies, record.latencyMs]
        : base.latencies,
    costSum: base.costSum + (record.estimatedCostUsd ?? 0),
  }

  const merged = existing
    ? buckets.map((b) => (b.timestamp === start ? updated : b))
    : [...buckets, updated]

  const cutoff =
    bucketStart(now, config.bucketDurationMs) - config.bucketDurationMs * (config.bucketCount - 1)
  return merged.filter((b) => b.timestamp >= cutoff).sort((a, b) => a.timestamp - b.timestamp)
}

export interface HealthMeta {
  lastRequestAt?: number | null
  lastErrorAt?: number | null
  lastErrorMessage?: string
}

/**
 * Merge several deployments' bucket lists into one provider-level list. Buckets
 * sharing a timestamp are summed and their RAW latencies concatenated so the
 * downstream `aggregate` recomputes percentiles over the union — percentiles
 * are never averaged across deployments.
 */
export function mergeBucketLists(bucketLists: SlidingWindowBucket[][]): SlidingWindowBucket[] {
  const byStart = new Map<number, SlidingWindowBucket>()
  for (const list of bucketLists) {
    for (const b of list) {
      const existing = byStart.get(b.timestamp)
      if (!existing) {
        byStart.set(b.timestamp, { ...b, latencies: [...b.latencies] })
        continue
      }
      byStart.set(b.timestamp, {
        timestamp: b.timestamp,
        requestCount: existing.requestCount + b.requestCount,
        successCount: existing.successCount + b.successCount,
        errorCount: existing.errorCount + b.errorCount,
        latencySum: existing.latencySum + b.latencySum,
        latencies: [...existing.latencies, ...b.latencies],
        costSum: existing.costSum + b.costSum,
      })
    }
  }
  return [...byStart.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/** Aggregate the buckets (plus out-of-band last-request/error metadata) into the
 * rolled-up `ProviderHealthMetrics` the routing engine and dashboard consume. */
export function aggregate(
  providerId: string,
  buckets: SlidingWindowBucket[],
  meta?: HealthMeta
): ProviderHealthMetrics {
  let totalRequests = 0
  let totalSuccesses = 0
  let totalErrors = 0
  let latencySum = 0
  let totalCost = 0
  const allLatencies: number[] = []
  const latencyTrend: number[] = []
  const errorRateTrend: number[] = []

  for (const b of buckets) {
    totalRequests += b.requestCount
    totalSuccesses += b.successCount
    totalErrors += b.errorCount
    latencySum += b.latencySum
    totalCost += b.costSum
    for (const l of b.latencies) allLatencies.push(l)
    latencyTrend.push(b.requestCount > 0 ? b.latencySum / b.requestCount : 0)
    errorRateTrend.push(b.requestCount > 0 ? b.errorCount / b.requestCount : 0)
  }

  const sorted = [...allLatencies].sort((a, b) => a - b)
  const successRate = totalRequests > 0 ? totalSuccesses / totalRequests : 1

  return {
    providerId,
    totalRequests,
    totalSuccesses,
    totalErrors,
    successRate,
    latencyP50: percentile(sorted, 0.5),
    latencyP95: percentile(sorted, 0.95),
    latencyAvg: totalRequests > 0 ? latencySum / totalRequests : 0,
    totalCost,
    uptimePercent: successRate,
    lastRequestAt: meta?.lastRequestAt ?? null,
    lastErrorAt: meta?.lastErrorAt ?? null,
    ...(meta?.lastErrorMessage ? { lastErrorMessage: meta.lastErrorMessage } : {}),
    latencyTrend,
    errorRateTrend,
  }
}
