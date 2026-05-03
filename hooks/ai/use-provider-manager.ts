"use client"

/**
 * Stub: provider-manager hook.
 *
 * Cognia exposes a hook that reads from the routing engine + circuit
 * breaker + load balancer. cognia-next deferred that infrastructure;
 * this stub returns inert defaults so components that import it render
 * cleanly.
 */

export interface ProviderHealth {
  status: "healthy" | "degraded" | "error" | "unknown"
  latencyMs: number
  errorRate: number
  successRate: number
  totalRequests: number
}

const DEFAULT: ProviderHealth = {
  status: "unknown",
  latencyMs: 0,
  errorRate: 0,
  successRate: 0,
  totalRequests: 0,
}

export function useProviderHealth(_providerId: string): {
  health: ProviderHealth
  isLoading: boolean
  refresh: () => Promise<void>
} {
  return {
    health: DEFAULT,
    isLoading: false,
    refresh: async () => undefined,
  }
}

export function useProviderManager() {
  return {
    providers: {} as Record<string, ProviderHealth>,
    isLoading: false,
    refresh: async () => undefined,
  }
}
