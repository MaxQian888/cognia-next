/**
 * Built-in routing strategy selectors.
 *
 * The five historical strategies are verbatim ports of the private
 * `selectBy*` methods that used to live inside `ProviderRoutingEngine`
 * (same scoring math — the engine's existing tests pin the behavior);
 * `least-busy` is new (LiteLLM's least-busy analog) and reads the
 * in-flight counter from the telemetry snapshot.
 *
 * All selectors are pure over (entries, telemetry): no module state, no
 * Date.now (the snapshot's injected clock), no I/O.
 */

import type { ModelMappingEntry } from "@/types/provider/model-mapping"
import type {
  RoutingStrategySelector,
  RoutingTelemetrySnapshot,
} from "@/types/provider/routing-strategy"

/** Quality = first in the chain (user-ordered priority). */
export const qualitySelector: RoutingStrategySelector = {
  id: "quality",
  select: (entries) => entries[0] ?? null,
}

/** Select the cheapest provider. */
export const costSelector: RoutingStrategySelector = {
  id: "cost",
  select: (entries, telemetry) => {
    if (entries.length === 0) return null
    let cheapest = entries[0]
    let cheapestPrice = Infinity
    for (const entry of entries) {
      const price = telemetry.getPricing(entry.providerId, entry.modelId)
      if (price !== undefined && price < cheapestPrice) {
        cheapestPrice = price
        cheapest = entry
      }
    }
    return cheapest
  },
}

/** Select the fastest provider based on recent latency. */
export const speedSelector: RoutingStrategySelector = {
  id: "speed",
  select: (entries, telemetry) => {
    if (entries.length === 0) return null
    let fastest = entries[0]
    let bestLatency = Infinity
    for (const entry of entries) {
      const metrics = telemetry.getHealthMetrics(entry.providerId)
      if (metrics && metrics.latencyP50 > 0 && metrics.latencyP50 < bestLatency) {
        bestLatency = metrics.latencyP50
        fastest = entry
      }
    }
    return fastest
  },
}

/** Balanced selection: score by success rate + inverse latency + inverse cost. */
export const balancedSelector: RoutingStrategySelector = {
  id: "balanced",
  select: (entries, telemetry) => {
    if (entries.length === 0) return null
    let best = entries[0]
    let bestScore = -Infinity
    for (const entry of entries) {
      const metrics = telemetry.getHealthMetrics(entry.providerId)
      const price = telemetry.getPricing(entry.providerId, entry.modelId)

      // Score components (normalized 0-1)
      const successScore = metrics ? metrics.successRate : 0.5
      const latencyScore =
        metrics && metrics.latencyP50 > 0
          ? Math.max(0, 1 - metrics.latencyP50 / 10000) // 10s = score 0
          : 0.5
      const costScore =
        price !== undefined
          ? Math.max(0, 1 - price / 50) // $50/1M = score 0
          : 0.5

      const score = successScore * 0.4 + latencyScore * 0.3 + costScore * 0.3
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }
    return best
  },
}

/** Adaptive: like balanced but penalizes recent errors more heavily. */
export const adaptiveSelector: RoutingStrategySelector = {
  id: "adaptive",
  select: (entries, telemetry) => {
    if (entries.length === 0) return null
    let best = entries[0]
    let bestScore = -Infinity
    for (const entry of entries) {
      const metrics = telemetry.getHealthMetrics(entry.providerId)

      // Heavily weight recent success rate
      const successScore = metrics ? metrics.successRate : 0.5
      const latencyScore =
        metrics && metrics.latencyP50 > 0 ? Math.max(0, 1 - metrics.latencyP50 / 10000) : 0.5
      // Penalize providers with recent errors (5-min decay)
      const recentErrorPenalty =
        metrics && metrics.lastErrorAt
          ? Math.max(0, 1 - (telemetry.now() - metrics.lastErrorAt) / 300000)
          : 0

      const score = successScore * 0.5 + latencyScore * 0.3 - recentErrorPenalty * 0.2
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }
    return best
  },
}

/**
 * Least-busy: route to the provider with the fewest in-flight requests
 * (ties broken by chain order). With no counter wired every provider
 * reads 0 and the first entry wins — the historical default.
 */
export const leastBusySelector: RoutingStrategySelector = {
  id: "least-busy",
  select: (entries, telemetry) => {
    if (entries.length === 0) return null
    let best = entries[0]
    let fewest = Infinity
    for (const entry of entries) {
      const inFlight = telemetry.getInFlight(entry.providerId)
      if (inFlight < fewest) {
        fewest = inFlight
        best = entry
      }
    }
    return best
  },
}

export const BUILT_IN_ROUTING_SELECTORS: readonly RoutingStrategySelector[] = [
  qualitySelector,
  costSelector,
  speedSelector,
  balancedSelector,
  adaptiveSelector,
  leastBusySelector,
]

/** A snapshot with safe defaults for optional sources. */
export function makeTelemetrySnapshot(parts: {
  getHealthMetrics: RoutingTelemetrySnapshot["getHealthMetrics"]
  getPricing: RoutingTelemetrySnapshot["getPricing"]
  getInFlight?: RoutingTelemetrySnapshot["getInFlight"]
  now?: RoutingTelemetrySnapshot["now"]
}): RoutingTelemetrySnapshot {
  return {
    getHealthMetrics: parts.getHealthMetrics,
    getPricing: parts.getPricing,
    getInFlight: parts.getInFlight ?? (() => 0),
    now: parts.now ?? (() => Date.now()),
  }
}
