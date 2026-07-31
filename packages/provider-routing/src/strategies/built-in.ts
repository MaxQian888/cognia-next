/**
 * Built-in routing strategy selectors.
 *
 * The existing strategies share deployment-aware telemetry; reliability is
 * the default objective and least-busy reads both provider and deployment
 * in-flight counters.
 *
 * All selectors are pure over (entries, telemetry): no module state, no
 * Date.now (the snapshot's injected clock), no I/O.
 */

import type {
  RoutingStrategySelector,
  RoutingTelemetrySnapshot,
} from "@cognia/provider-types/routing-strategy"
import { deploymentKeyOfEntry } from "@cognia/provider-types/deployment"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import type { ProviderHealthMetrics } from "@cognia/provider-types/health-metrics"

const MIN_RELIABILITY_SAMPLE = 10

function deploymentMetrics(
  entry: ModelMappingEntry,
  telemetry: RoutingTelemetrySnapshot
): ProviderHealthMetrics | undefined {
  const key = deploymentKeyOfEntry(entry)
  return (
    (key ? telemetry.getDeploymentHealth?.(key) : undefined) ??
    telemetry.getHealthMetrics(entry.providerId)
  )
}

function p95(metrics: ProviderHealthMetrics | undefined): number {
  if (!metrics) return 0
  return metrics.latencyP95 > 0 ? metrics.latencyP95 : metrics.latencyP50
}

function deploymentInFlight(entry: ModelMappingEntry, telemetry: RoutingTelemetrySnapshot): number {
  const key = deploymentKeyOfEntry(entry)
  return Math.max(
    telemetry.getInFlight(entry.providerId),
    key ? (telemetry.getDeploymentInFlight?.(key) ?? 0) : 0
  )
}

/** Reliability = warm healthy cohort, then success, p95, load, chain order. */
export const reliabilitySelector: RoutingStrategySelector = {
  id: "reliability",
  select: (entries, telemetry) => {
    if (entries.length === 0) return null
    const warm = entries.filter(
      (entry) => (deploymentMetrics(entry, telemetry)?.totalRequests ?? 0) >= MIN_RELIABILITY_SAMPLE
    )
    if (warm.length === 0) return entries[0]
    return [...warm].sort((a, b) => {
      const aMetrics = deploymentMetrics(a, telemetry)
      const bMetrics = deploymentMetrics(b, telemetry)
      const success = (bMetrics?.successRate ?? 0) - (aMetrics?.successRate ?? 0)
      if (success !== 0) return success
      const latencyA = p95(aMetrics) || Number.POSITIVE_INFINITY
      const latencyB = p95(bMetrics) || Number.POSITIVE_INFINITY
      if (latencyA !== latencyB) return latencyA - latencyB
      return deploymentInFlight(a, telemetry) - deploymentInFlight(b, telemetry)
    })[0]
  },
}

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
      const metrics = deploymentMetrics(entry, telemetry)
      const latency = p95(metrics)
      if (latency > 0 && latency < bestLatency) {
        bestLatency = latency
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
      const metrics = deploymentMetrics(entry, telemetry)
      const price = telemetry.getPricing(entry.providerId, entry.modelId)

      // Score components (normalized 0-1)
      const successScore = metrics ? metrics.successRate : 0.5
      const latencyScore = p95(metrics) > 0 ? 1 / (1 + p95(metrics)) : 0.5
      const costScore = price !== undefined ? 1 / (1 + price) : 0.5

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
      const metrics = deploymentMetrics(entry, telemetry)

      // Heavily weight recent success rate
      const successScore = metrics ? metrics.successRate : 0.5
      const latencyScore = p95(metrics) > 0 ? 1 / (1 + p95(metrics)) : 0.5
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
      const inFlight = deploymentInFlight(entry, telemetry)
      if (inFlight < fewest) {
        fewest = inFlight
        best = entry
      }
    }
    return best
  },
}

export const BUILT_IN_ROUTING_SELECTORS: readonly RoutingStrategySelector[] = [
  reliabilitySelector,
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
