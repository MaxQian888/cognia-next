/**
 * Pluggable routing-strategy contract (LiteLLM `CustomRoutingStrategy`
 * analog). One pure-selector interface serves the built-in strategies
 * (quality/cost/speed/balanced/adaptive/least-busy), the difficulty
 * router, and plugin-contributed strategies — they all plug into the same
 * registry consulted by `ProviderRoutingEngine.applyStrategy`.
 */

import type { ModelMappingEntry } from "./model-mapping"
import type { ProviderHealthMetrics } from "./health-metrics"
import type {
  RoutingCapabilityRequirements,
  RoutingStrategy,
  RoutingSurface,
  TaskClassification,
} from "./auto-router"

/**
 * A strategy id: one of the built-in `RoutingStrategy` union members or a
 * custom (plugin) id. `(string & {})` keeps literal autocomplete while
 * accepting arbitrary ids.
 */
export type RoutingStrategyId = RoutingStrategy | (string & {})

/** Read-only telemetry surface a selector scores candidates with. */
export interface RoutingTelemetrySnapshot {
  getHealthMetrics: (providerId: string) => ProviderHealthMetrics | undefined
  getPricing: (providerId: string, modelId: string) => number | undefined
  /** Concurrent in-flight requests per provider (least-busy source; 0 = idle/unknown). */
  getInFlight: (providerId: string) => number
  /** Injectable clock (adaptive's recent-error decay; deterministic tests). */
  now: () => number
  /**
   * Deployment-granular health (`providerId::modelId[::keyId]` keys — see
   * `types/provider/deployment.ts`). Optional, additive: selectors written
   * against the provider-level surface keep working unchanged.
   */
  getDeploymentHealth?: (deploymentKey: string) => ProviderHealthMetrics | undefined
  /** Deployment-granular in-flight count. Optional, additive. */
  getDeploymentInFlight?: (deploymentKey: string) => number
}

/** Per-request context available to context-aware selectors. */
export interface RoutingDecisionContext {
  /** Last user prompt text, reserved for the built-in difficulty selector. */
  promptText?: string
  /** Rough token estimate of the outgoing prompt. */
  estimatedInputTokens?: number
  /** Locally derived request features available to plugin selectors. */
  classification?: TaskClassification
  requirements?: RoutingCapabilityRequirements
  surface?: RoutingSurface
}

/**
 * A pure candidate selector. MUST NOT throw for routing to stay reliable —
 * the engine treats a throwing selector as "no preference" (first entry).
 */
export interface RoutingStrategySelector {
  id: RoutingStrategyId
  /** Human-readable label for strategy pickers (defaults to the id). */
  label?: string
  select: (
    entries: readonly ModelMappingEntry[],
    telemetry: RoutingTelemetrySnapshot,
    ctx?: RoutingDecisionContext
  ) => ModelMappingEntry | null
  /** Async companion used by subprocess-backed or otherwise awaitable plugins. */
  selectAsync?: (
    entries: readonly ModelMappingEntry[],
    telemetry: RoutingTelemetrySnapshot,
    ctx?: RoutingDecisionContext
  ) => Promise<ModelMappingEntry | null>
}
