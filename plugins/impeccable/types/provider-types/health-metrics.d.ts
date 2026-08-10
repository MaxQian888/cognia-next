/**
 * Health Metrics type definitions
 * Real-time per-provider health metrics with sliding window tracking
 */
/** A single time bucket in the sliding window */
interface SlidingWindowBucket {
  /** Bucket start timestamp (ms) */
  timestamp: number
  /** Number of requests in this bucket */
  requestCount: number
  /** Number of successful requests */
  successCount: number
  /** Number of failed requests */
  errorCount: number
  /** Sum of latencies for averaging */
  latencySum: number
  /** Individual latencies for percentile calculation (capped at 100 per bucket) */
  latencies: number[]
  /** Estimated cost in USD accumulated in this bucket */
  costSum: number
}
/** Aggregated metrics for a provider */
interface ProviderHealthMetrics {
  providerId: string
  /** Total requests across all buckets */
  totalRequests: number
  /** Total successful requests */
  totalSuccesses: number
  /** Total errors */
  totalErrors: number
  /** Success rate (0-1) */
  successRate: number
  /** Median latency in ms */
  latencyP50: number
  /** 95th percentile latency in ms */
  latencyP95: number
  /** Average latency in ms */
  latencyAvg: number
  /** Total estimated cost in USD */
  totalCost: number
  /** Uptime percentage (time since last error / total tracked time) */
  uptimePercent: number
  /** Last request timestamp */
  lastRequestAt: number | null
  /** Last error timestamp */
  lastErrorAt: number | null
  /** Last error message (most recent) */
  lastErrorMessage?: string
  /** Latency trend data points (for sparkline visualization) */
  latencyTrend: number[]
  /** Error rate trend data points (for sparkline visualization) */
  errorRateTrend: number[]
}
/** Empty metrics for a provider with no data */
declare const EMPTY_PROVIDER_HEALTH_METRICS: Omit<ProviderHealthMetrics, "providerId">
/** Dashboard data for the health tab */
interface HealthDashboardData {
  /** Per-provider metrics */
  providers: Record<string, ProviderHealthMetrics>
  /** Global aggregated metrics */
  global: {
    totalRequests: number
    totalCost: number
    avgLatency: number
    overallSuccessRate: number
  }
  /** Last refresh timestamp */
  lastRefreshAt: number
}
/** Health metrics collector configuration */
interface HealthMetricsConfig {
  /** Duration of each bucket in ms (default: 60000 = 1 minute) */
  bucketDurationMs: number
  /** Number of buckets to retain (default: 5 = 5 minutes of data) */
  bucketCount: number
  /** Maximum latencies stored per bucket for percentile calculation */
  maxLatenciesPerBucket: number
}
/** Default health metrics configuration */
declare const DEFAULT_HEALTH_METRICS_CONFIG: HealthMetricsConfig
/** Record to submit to the metrics collector */
interface MetricsRecord {
  providerId: string
  /** Model the turn ran against (deployment granularity). Absent → wildcard bucket. */
  modelId?: string
  /** Credential id (multi-key rotation granularity). */
  keyId?: string
  success: boolean
  latencyMs: number
  estimatedCostUsd?: number
  errorMessage?: string
  timestamp?: number
}
/** Out-of-band last-request/error metadata carried alongside buckets. */
interface HealthMetricsMeta {
  lastRequestAt: number | null
  lastErrorAt: number | null
  lastErrorMessage?: string
}
/** Per-deployment aggregate (same shape as provider metrics + its store key). */
interface DeploymentHealthMetrics extends ProviderHealthMetrics {
  deploymentKey: string
}
/** Health metrics store state (non-persisted, in-memory only) */
interface HealthMetricsStoreState {
  /** Raw buckets per deployment key (`providerId::modelId[::keyId]`) */
  buckets: Record<string, SlidingWindowBucket[]>
  /** Aggregated metrics per provider (merged across its deployments) */
  metrics: Record<string, ProviderHealthMetrics>
  /** Out-of-band meta per deployment key */
  deploymentMeta: Record<string, HealthMetricsMeta>
  /** Record a completed request */
  record: (record: MetricsRecord) => void
  /** Get metrics for a specific provider */
  getMetrics: (providerId: string) => ProviderHealthMetrics
  /** Get metrics for a single deployment (`providerId::modelId[::keyId]`) */
  getDeploymentMetrics: (deploymentKey: string) => DeploymentHealthMetrics
  /** List known deployment keys, optionally restricted to one provider */
  listDeploymentKeys: (providerId?: string) => string[]
  /** Get dashboard data for all providers */
  getDashboardData: () => HealthDashboardData
  /** Reset all metrics */
  resetAll: () => void
  /** Reset metrics for a specific provider */
  resetProvider: (providerId: string) => void
}

export {
  DEFAULT_HEALTH_METRICS_CONFIG,
  type DeploymentHealthMetrics,
  EMPTY_PROVIDER_HEALTH_METRICS,
  type HealthDashboardData,
  type HealthMetricsConfig,
  type HealthMetricsMeta,
  type HealthMetricsStoreState,
  type MetricsRecord,
  type ProviderHealthMetrics,
  type SlidingWindowBucket,
}
