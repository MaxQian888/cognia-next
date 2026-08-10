import {
  SlidingWindowBucket,
  ProviderHealthMetrics,
  MetricsRecord,
  HealthMetricsConfig,
} from "@cognia/provider-types/health-metrics"

/**
 * Pure sliding-window health-metrics collector for providers.
 *
 * Shapes (`SlidingWindowBucket`, `ProviderHealthMetrics`, `MetricsRecord`,
 * config) live in `types/provider/health-metrics.ts`; this is the bucketing +
 * aggregation logic the store drives. Pure so it unit-tests deterministically.
 */

/**
 * Fold a completed-request record into the bucket list, pruning buckets that
 * have aged out of the retention window. Returns a new, time-sorted array.
 */
declare function recordToBuckets(
  buckets: SlidingWindowBucket[],
  record: MetricsRecord,
  config: HealthMetricsConfig,
  now: number
): SlidingWindowBucket[]
interface HealthMeta {
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
declare function mergeBucketLists(bucketLists: SlidingWindowBucket[][]): SlidingWindowBucket[]
/** Aggregate the buckets (plus out-of-band last-request/error metadata) into the
 * rolled-up `ProviderHealthMetrics` the routing engine and dashboard consume. */
declare function aggregate(
  providerId: string,
  buckets: SlidingWindowBucket[],
  meta?: HealthMeta
): ProviderHealthMetrics

export { type HealthMeta, aggregate, mergeBucketLists, recordToBuckets }
