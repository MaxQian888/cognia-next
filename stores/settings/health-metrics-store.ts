"use client"

/**
 * Provider health-metrics store (ADR-0043 Phase 4).
 *
 * Real sliding-window reliability metrics, bucketed per DEPLOYMENT
 * (`providerId::modelId[::keyId]` — see `types/provider/deployment.ts`) and
 * aggregated back to provider level for the routing engine and dashboard.
 * Each completed turn is fed in via `record` (from
 * `lib/claude/provider-telemetry.ts`); the bucketing + aggregation logic lives
 * in the pure `lib/ai/providers/health-metrics-collector` so this store is a
 * thin, deterministic wrapper. In-memory only (non-persisted) — telemetry
 * resets on reload.
 */

import { create } from "zustand"

import {
  aggregate,
  mergeBucketLists,
  recordToBuckets,
} from "@/lib/ai/providers/health-metrics-collector"
import {
  deploymentKeyOf,
  DEPLOYMENT_MODEL_WILDCARD,
  providerIdOfDeploymentKey,
} from "@/types/provider/deployment"
import {
  DEFAULT_HEALTH_METRICS_CONFIG,
  EMPTY_PROVIDER_HEALTH_METRICS,
  type DeploymentHealthMetrics,
  type HealthDashboardData,
  type HealthMetricsMeta,
  type HealthMetricsStoreState,
  type MetricsRecord,
  type ProviderHealthMetrics,
} from "@/types/provider/health-metrics"

const CONFIG = DEFAULT_HEALTH_METRICS_CONFIG

function emptyMetrics(providerId: string): ProviderHealthMetrics {
  return { providerId, ...EMPTY_PROVIDER_HEALTH_METRICS }
}

/**
 * Store key for a record. Ids that cannot be encoded (contain `::`) fall back
 * to the raw providerId so the sample is never dropped; `keysForProvider`
 * matches that fallback too.
 */
function deploymentKeyForRecord(record: MetricsRecord): string {
  return (
    deploymentKeyOf({
      providerId: record.providerId,
      modelId: record.modelId ?? DEPLOYMENT_MODEL_WILDCARD,
      ...(record.keyId !== undefined ? { keyId: record.keyId } : {}),
    }) ?? record.providerId
  )
}

function keyBelongsToProvider(key: string, providerId: string): boolean {
  return key === providerId || providerIdOfDeploymentKey(key) === providerId
}

function keysForProvider(buckets: Record<string, unknown>, providerId: string): string[] {
  return Object.keys(buckets).filter((k) => keyBelongsToProvider(k, providerId))
}

export const useHealthMetricsStore = create<HealthMetricsStoreState>((set, get) => ({
  buckets: {},
  metrics: {},
  deploymentMeta: {},

  record: (record: MetricsRecord) => {
    const now = record.timestamp ?? Date.now()
    const key = deploymentKeyForRecord(record)
    set((s) => {
      const prevProvider = s.metrics[record.providerId]
      const prevMeta = s.deploymentMeta[key]
      const nextBuckets = recordToBuckets(s.buckets[key] ?? [], record, CONFIG, now)
      const buckets = { ...s.buckets, [key]: nextBuckets }
      const deploymentMeta: HealthMetricsMeta = {
        lastRequestAt: now,
        lastErrorAt: record.success ? (prevMeta?.lastErrorAt ?? null) : now,
        ...(record.success
          ? prevMeta?.lastErrorMessage
            ? { lastErrorMessage: prevMeta.lastErrorMessage }
            : {}
          : record.errorMessage
            ? { lastErrorMessage: record.errorMessage }
            : {}),
      }
      // Provider-level rollup: merge RAW buckets across this provider's
      // deployments and re-aggregate (percentiles over the union — never
      // averaged). Carry last-request / last-error metadata forward across
      // records (the collector aggregates buckets but not the out-of-band
      // "last error" string).
      const merged = mergeBucketLists(
        keysForProvider(buckets, record.providerId).map((k) => buckets[k])
      )
      const nextMetrics = aggregate(record.providerId, merged, {
        lastRequestAt: now,
        lastErrorAt: record.success ? (prevProvider?.lastErrorAt ?? null) : now,
        lastErrorMessage: record.success ? prevProvider?.lastErrorMessage : record.errorMessage,
      })
      return {
        buckets,
        metrics: { ...s.metrics, [record.providerId]: nextMetrics },
        deploymentMeta: { ...s.deploymentMeta, [key]: deploymentMeta },
      }
    })
  },

  getMetrics: (providerId) => get().metrics[providerId] ?? emptyMetrics(providerId),

  getDeploymentMetrics: (deploymentKey): DeploymentHealthMetrics => {
    const s = get()
    const buckets = s.buckets[deploymentKey]
    const providerId = providerIdOfDeploymentKey(deploymentKey) ?? deploymentKey
    if (!buckets) return { deploymentKey, ...emptyMetrics(providerId) }
    return { deploymentKey, ...aggregate(providerId, buckets, s.deploymentMeta[deploymentKey]) }
  },

  listDeploymentKeys: (providerId) => {
    const keys = Object.keys(get().buckets)
    return providerId === undefined ? keys : keys.filter((k) => keyBelongsToProvider(k, providerId))
  },

  getDashboardData: (): HealthDashboardData => {
    const providers = get().metrics
    let totalRequests = 0
    let totalCost = 0
    let latencyWeighted = 0
    let totalSuccesses = 0
    for (const m of Object.values(providers)) {
      totalRequests += m.totalRequests
      totalCost += m.totalCost
      latencyWeighted += m.latencyAvg * m.totalRequests
      totalSuccesses += m.totalSuccesses
    }
    return {
      providers,
      global: {
        totalRequests,
        totalCost,
        avgLatency: totalRequests > 0 ? latencyWeighted / totalRequests : 0,
        overallSuccessRate: totalRequests > 0 ? totalSuccesses / totalRequests : 1,
      },
      lastRefreshAt: Date.now(),
    }
  },

  resetAll: () => set({ buckets: {}, metrics: {}, deploymentMeta: {} }),

  resetProvider: (providerId) =>
    set((s) => {
      const buckets = { ...s.buckets }
      const deploymentMeta = { ...s.deploymentMeta }
      for (const k of keysForProvider(s.buckets, providerId)) {
        delete buckets[k]
        delete deploymentMeta[k]
      }
      const metrics = { ...s.metrics }
      delete metrics[providerId]
      return { buckets, metrics, deploymentMeta }
    }),
}))
