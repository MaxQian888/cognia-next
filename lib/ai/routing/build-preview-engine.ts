/**
 * Routing-engine factory shared by the chat send path and the settings
 * routing-tab's test/preview panel.
 *
 * Assembles a `ProviderRoutingEngine` whose deps read the LIVE in-memory
 * stores (health metrics, circuit breaker, today-spend mirror, rate window)
 * plus the given `AppSettings` — exactly what `resolveSendOptions` uses, so a
 * preview answers "which provider WOULD the next send pick right now".
 * Selection is pure + synchronous: building and consulting the engine has no
 * side effects and never awaits.
 */

import { createMappingRegistry } from "./model-mapping-registry"
import { ProviderRoutingEngine, type RoutingEngineDeps } from "./provider-routing-engine"
import { DEFAULT_ROUTING_CONFIG } from "@/types/provider/model-mapping"
import { getModelConfig } from "@/types/provider/provider"
import { getModelContextLimits, getModelMaxTokens } from "@/lib/ai/model-limits"
import {
  resolveModelPriceUsdPer1M,
  type PriceLookupSettings,
} from "@/lib/ai/providers/model-pricing"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"
import { useRateLimitStore } from "@/stores/settings/rate-limit-store"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
// Side-effect import: registers the "difficulty" strategy so every engine
// (send path + preview panel) can resolve it by id.
import "./difficulty-router"
import type { AppSettings } from "@/lib/claude/types"

/** The slice of AppSettings the engine deps actually read. */
export type RoutingEngineSettings = Pick<
  AppSettings,
  "modelMappings" | "routingConfig" | "providerSettings" | "customProviders"
>

/** Build the live-store-backed deps `resolveSendOptions` wires into the engine. */
export function buildRoutingEngineDeps(appSettings: RoutingEngineSettings): RoutingEngineDeps {
  return {
    // Real reliability telemetry (ADR-0043 Phase 4), fed per-turn by
    // `recordProviderOutcome`. A provider with zero recorded requests reports
    // `undefined` so the engine treats it as "no-info" and keeps priority
    // order until rolling stats accrue.
    getHealthMetrics: (id) => {
      const m = useHealthMetricsStore.getState().getMetrics(id)
      return m.totalRequests > 0 ? m : undefined
    },
    getCircuitBreakerState: (id) => useCircuitBreakerStore.getState().getState(id),
    isProviderAvailable: (id) => {
      // An OPEN circuit breaker takes a provider out of rotation; otherwise
      // fall back to the provider's enabled flag.
      if (!useCircuitBreakerStore.getState().isAvailable(id)) return false
      const enabled = appSettings.providerSettings?.[id]?.enabled
      // Custom providers carry their own `enabled` flag.
      const custom = appSettings.customProviders?.find((p) => p.id === id)
      return enabled !== false || (custom?.enabled !== false && Boolean(custom))
    },
    getPricing: (id, modelId) =>
      resolveModelPriceUsdPer1M(id, modelId, {
        providerSettings: appSettings.providerSettings,
        customProviders: appSettings.customProviders,
      } as PriceLookupSettings),
    // Durable today-spend mirror (hydrated from Dexie at boot, incremented
    // per turn) — makes `dailyCostBudget` survive reloads.
    getTodaySpend: (id) => useProviderCostMirrorStore.getState().getTodaySpend(id),
    // Usable input window = catalog context length (heuristic fallback)
    // minus an output/reserve allowance — feeds the engine's LiteLLM-style
    // context-window pre-check.
    getContextWindow: (id, modelId) => {
      const config = getModelConfig(id, modelId)
      const raw = config?.contextLength ?? getModelMaxTokens(modelId)
      const limits = getModelContextLimits(modelId)
      const maxOutput = config?.maxOutputTokens
      const reserve = Math.min(
        limits.reserveTokens,
        typeof maxOutput === "number" && maxOutput > 0 ? maxOutput : Infinity
      )
      return Math.max(0, raw - reserve)
    },
    // Trailing-minute RPM/TPM window (fed by recordProviderOutcome) — the
    // engine deprioritizes providers at their configured rate ceiling.
    getRate: (id) => useRateLimitStore.getState().getRate(id),
    // Concurrent in-flight turns (begin/settle around each send) — the
    // least-busy strategy's signal.
    getInFlight: (id) => useInFlightStore.getState().getInFlight(id),
  }
}

/** Assemble a routing engine over the given settings + live telemetry stores. */
export function buildRoutingEngine(appSettings: RoutingEngineSettings): ProviderRoutingEngine {
  const registry = createMappingRegistry(appSettings.modelMappings ?? [])
  const routingConfig = appSettings.routingConfig ?? DEFAULT_ROUTING_CONFIG
  return new ProviderRoutingEngine(registry, routingConfig, buildRoutingEngineDeps(appSettings))
}

/**
 * Push per-provider circuit-breaker overrides (`ProviderConstraint.
 * circuitConfig` — allowed_fails / cooldown_time analog) into the live
 * breaker store. Idempotent merge; called from the send path right before
 * the engine consults breaker state so settings changes apply without a
 * dedicated subscription.
 */
export function applyCircuitConfigOverrides(
  constraints: ReadonlyArray<import("@/types/provider/model-mapping").ProviderConstraint>
): void {
  if (constraints.length === 0) return
  const store = useCircuitBreakerStore.getState()
  for (const constraint of constraints) {
    if (constraint.enabled && constraint.circuitConfig) {
      store.updateConfig(constraint.providerId, constraint.circuitConfig)
    }
  }
}
