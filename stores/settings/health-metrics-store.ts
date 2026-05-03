"use client"

/**
 * Stub: provider health-metrics store.
 *
 * Cognia ships a real-time health-metrics store wired to the provider
 * manager's circuit breaker / availability monitor / load balancer. That
 * reliability infrastructure was deferred from cognia-next's provider
 * port (see plan §scope decision: full settings UI, defer reliability
 * infra). This stub keeps the components that read health metrics
 * (provider-health-status, health-tab) compiling and rendering an
 * "unknown" state until the manager lands.
 */

import { create } from "zustand"

export interface ProviderHealthMetricsSummary {
  /** Overall health roll-up. Stub always reports unknown. */
  status: "healthy" | "degraded" | "error" | "unknown"
  latencyMs: number
  errorRate: number
  successRate: number
  lastChecked: number
  /** Last error message string, when status is error. */
  lastError?: string
  /** Recent samples for sparkline. */
  samples: Array<{ at: number; latencyMs: number; ok: boolean }>
  /** Total request count window. */
  totalRequests: number
}

interface HealthMetricsState {
  metrics: Record<string, ProviderHealthMetricsSummary>
  getMetrics: (providerId: string) => ProviderHealthMetricsSummary
  refreshMetrics: (providerId: string) => Promise<void>
  resetMetrics: (providerId: string) => void
}

const DEFAULT: ProviderHealthMetricsSummary = {
  status: "unknown",
  latencyMs: 0,
  errorRate: 0,
  successRate: 0,
  lastChecked: 0,
  samples: [],
  totalRequests: 0,
}

export const useHealthMetricsStore = create<HealthMetricsState>((set, get) => ({
  metrics: {},
  getMetrics: (providerId) => get().metrics[providerId] ?? DEFAULT,
  refreshMetrics: async () => {
    // Stub: real implementation pings the availability monitor.
  },
  resetMetrics: (providerId) => {
    set((s) => {
      const next = { ...s.metrics }
      delete next[providerId]
      return { metrics: next }
    })
  },
}))
