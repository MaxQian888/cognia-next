"use client"

/**
 * Provider health-metrics store (ADR-0043 Phase 4).
 *
 * Real sliding-window reliability metrics per provider. Each completed turn is
 * fed in via `record` (from `lib/claude/provider-telemetry.ts`); the bucketing +
 * aggregation logic lives in the pure `lib/ai/providers/health-metrics-collector`
 * so this store is a thin, deterministic wrapper. The routing engine reads
 * `getMetrics`/`getDashboardData` back via `build-options` deps. In-memory only
 * (non-persisted) — telemetry resets on reload.
 */

import { create } from "zustand"

import { aggregate, recordToBuckets } from "@/lib/ai/providers/health-metrics-collector"
import {
  DEFAULT_HEALTH_METRICS_CONFIG,
  EMPTY_PROVIDER_HEALTH_METRICS,
  type HealthDashboardData,
  type HealthMetricsStoreState,
  type MetricsRecord,
  type ProviderHealthMetrics,
} from "@/types/provider/health-metrics"

const CONFIG = DEFAULT_HEALTH_METRICS_CONFIG

function emptyMetrics(providerId: string): ProviderHealthMetrics {
  return { providerId, ...EMPTY_PROVIDER_HEALTH_METRICS }
}

export const useHealthMetricsStore = create<HealthMetricsStoreState>((set, get) => ({
  buckets: {},
  metrics: {},

  record: (record: MetricsRecord) => {
    const now = record.timestamp ?? Date.now()
    set((s) => {
      const prev = s.metrics[record.providerId]
      const nextBuckets = recordToBuckets(s.buckets[record.providerId] ?? [], record, CONFIG, now)
      // Carry last-request / last-error metadata forward across records (the
      // collector aggregates buckets but not the out-of-band "last error" string).
      const nextMetrics = aggregate(record.providerId, nextBuckets, {
        lastRequestAt: now,
        lastErrorAt: record.success ? (prev?.lastErrorAt ?? null) : now,
        lastErrorMessage: record.success ? prev?.lastErrorMessage : record.errorMessage,
      })
      return {
        buckets: { ...s.buckets, [record.providerId]: nextBuckets },
        metrics: { ...s.metrics, [record.providerId]: nextMetrics },
      }
    })
  },

  getMetrics: (providerId) => get().metrics[providerId] ?? emptyMetrics(providerId),

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

  resetAll: () => set({ buckets: {}, metrics: {} }),

  resetProvider: (providerId) =>
    set((s) => {
      const buckets = { ...s.buckets }
      delete buckets[providerId]
      const metrics = { ...s.metrics }
      delete metrics[providerId]
      return { buckets, metrics }
    }),
}))
