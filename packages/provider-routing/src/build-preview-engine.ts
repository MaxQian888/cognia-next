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
import { getSessionDeployment, releaseSessionDeployment } from "./session-affinity-store"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import { getModelConfig } from "@cognia/provider-types/provider"
import {
  resolveModelPriceUsdPer1M,
  type PriceLookupSettings,
} from "@cognia/provider-core/providers/model-pricing"
import {
  getModelContextLimits,
  getModelMaxTokens,
  getProviderRoutingRuntimeAdapters,
} from "./runtime-adapters"
// Side-effect import: registers the "difficulty" strategy so every engine
// (send path + preview panel) can resolve it by id.
import "./difficulty-router"
import type { ModelMapping, RoutingConfig } from "@cognia/provider-types/model-mapping"

/** The slice of AppSettings the engine deps actually read. */
export interface RoutingEngineSettings extends PriceLookupSettings {
  modelMappings?: ModelMapping[]
  routingConfig?: RoutingConfig
  providerSettings?: PriceLookupSettings["providerSettings"] &
    Record<string, { enabled?: boolean } | undefined>
  customProviders?: Array<{
    id: string
    providerId?: string
    enabled?: boolean
    defaultModel?: string
    customModelMetadata?: NonNullable<
      PriceLookupSettings["customProviders"]
    >[number]["customModelMetadata"]
  }>
}

/** Build the live-store-backed deps `resolveSendOptions` wires into the engine. */
export function buildRoutingEngineDeps(appSettings: RoutingEngineSettings): RoutingEngineDeps {
  const runtime = getProviderRoutingRuntimeAdapters()
  return {
    // Real reliability telemetry (ADR-0043 Phase 4), fed per-turn by
    // `recordProviderOutcome`. A provider with zero recorded requests reports
    // `undefined` so the engine treats it as "no-info" and keeps priority
    // order until rolling stats accrue.
    getHealthMetrics: (id) => runtime.getHealthMetrics(id),
    getCircuitBreakerState: (id) => runtime.getCircuitBreakerState(id),
    isProviderAvailable: (id) => {
      // An OPEN circuit breaker takes a provider out of rotation; otherwise
      // fall back to the provider's enabled flag.
      if (!runtime.isCircuitBreakerAvailable(id)) return false
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
    getTodaySpend: (id) => runtime.getTodaySpend(id),
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
    getRate: (id) => runtime.getRate(id),
    // Concurrent in-flight turns (begin/settle around each send) — the
    // least-busy strategy's signal.
    getInFlight: (id) => runtime.getInFlight(id),

    // ---- Deployment granularity (providerId::modelId[::keyId] keys) ------
    getDeploymentHealth: (key) => runtime.getDeploymentHealth(key),
    getDeploymentCircuitBreakerState: (key) => runtime.getDeploymentCircuitBreakerState(key),
    getDeploymentRate: (key) => runtime.getDeploymentRate(key),
    getDeploymentInFlight: (key) => runtime.getDeploymentInFlight(key),
    // Session affinity (multi-turn stickiness; pinned by provider-telemetry).
    getSessionDeployment: (sessionId) =>
      runtime.getSessionDeployment(sessionId) ?? getSessionDeployment(sessionId),
    releaseSessionDeployment: (sessionId) => {
      runtime.releaseSessionDeployment(sessionId)
      releaseSessionDeployment(sessionId)
    },
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
  constraints: ReadonlyArray<import("@cognia/provider-types/model-mapping").ProviderConstraint>
): void {
  if (constraints.length === 0) return
  const runtime = getProviderRoutingRuntimeAdapters()
  for (const constraint of constraints) {
    if (constraint.enabled && constraint.circuitConfig) {
      runtime.updateCircuitConfig(constraint.providerId, constraint.circuitConfig)
    }
  }
}

/**
 * Hydrate the in-memory circuit-breaker store from the PERSISTED routing
 * config: global enable + defaults (`routingConfig.circuitBreaker`) first,
 * then per-provider overrides. Idempotent; called from the send path so
 * reliability routing survives reloads. An absent `circuitBreaker` block
 * leaves the store untouched (historical opt-in-off behavior).
 */
export function applyCircuitBreakerSettings(
  routingConfig: import("@cognia/provider-types/model-mapping").RoutingConfig
): void {
  const cb = routingConfig.circuitBreaker
  if (cb) {
    const runtime = getProviderRoutingRuntimeAdapters()
    const { enabled, ...config } = cb
    runtime.setCircuitBreakerEnabled(enabled)
    if (Object.keys(config).length > 0) runtime.setCircuitBreakerSettings(config)
  }
  applyCircuitConfigOverrides(routingConfig.providerConstraints)
}
