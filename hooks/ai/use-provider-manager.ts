"use client"

import { useCallback, useMemo } from "react"
import type { ProviderHealthMetrics } from "@cognia/provider-types/health-metrics"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"

export interface ProviderHealth {
  status: "healthy" | "degraded" | "error" | "unknown"
  latencyMs: number
  errorRate: number
  successRate: number
  totalRequests: number
}

function projectHealth(metrics: ProviderHealthMetrics): ProviderHealth {
  const status: ProviderHealth["status"] =
    metrics.totalRequests === 0
      ? "unknown"
      : metrics.successRate >= 0.95
        ? "healthy"
        : metrics.successRate >= 0.5
          ? "degraded"
          : "error"

  return {
    status,
    latencyMs: metrics.latencyP95,
    errorRate: metrics.totalRequests === 0 ? 0 : metrics.totalErrors / metrics.totalRequests,
    successRate: metrics.totalRequests === 0 ? 0 : metrics.successRate,
    totalRequests: metrics.totalRequests,
  }
}

export function useProviderHealth(providerId: string): {
  health: ProviderHealth
  isLoading: boolean
  refresh: () => Promise<void>
} {
  const metrics = useHealthMetricsStore((state) => state.metrics[providerId])
  const getMetrics = useHealthMetricsStore((state) => state.getMetrics)
  const health = useMemo(
    () => projectHealth(metrics ?? getMetrics(providerId)),
    [getMetrics, metrics, providerId]
  )
  const refresh = useCallback(async () => {
    getMetrics(providerId)
  }, [getMetrics, providerId])

  return {
    health,
    isLoading: false,
    refresh,
  }
}

export function useProviderManager(): {
  providers: Record<string, ProviderHealth>
  isLoading: boolean
  refresh: () => Promise<void>
} {
  const metrics = useHealthMetricsStore((state) => state.metrics)
  const providers = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(metrics).map(([providerId, providerMetrics]) => [
          providerId,
          projectHealth(providerMetrics),
        ])
      ),
    [metrics]
  )

  return {
    providers,
    isLoading: false,
    refresh: async () => undefined,
  }
}
