/**
 * Plugin-contributed routing strategies (`manifest.routingStrategies`) —
 * the LiteLLM `CustomRoutingStrategy` analog, declared as ADR-0026
 * lazy-factory entries and registered into the routing strategy registry
 * on plugin enable.
 *
 * The registered strategy id is namespaced as `${pluginId}:${id}` so a
 * plugin can never shadow a built-in strategy or another plugin's, and
 * `RoutingConfig.strategy` / per-request overrides reference it by that
 * full id.
 */

import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import type {
  RoutingDecisionContext,
  RoutingTelemetrySnapshot,
} from "@cognia/provider-types/routing-strategy"

/** One declarative routing-strategy contribution. */
export interface PluginRoutingStrategyDef {
  /** Strategy id (namespaced to `${pluginId}:${id}` at registration). */
  id: string
  /** Human-readable label for the strategy picker. */
  label: string
  description?: string
  /** Relative module path inside the plugin (lazy-imported on enable). */
  entry: string
  /** Export name of the factory function in `entry`. */
  export: string
}

/** What the factory must return: the pure selector core. */
export interface PluginRoutingStrategySelectorLike {
  select: (
    entries: readonly ModelMappingEntry[],
    telemetry: RoutingTelemetrySnapshot,
    ctx?: RoutingDecisionContext
  ) => ModelMappingEntry | null
}

/** Factory context handed to the plugin's exported factory. */
export interface PluginRoutingStrategyContext {
  /** The namespaced id the selector registers under. */
  strategyId: string
  pluginId: string
}

export type PluginRoutingStrategyFactory = (
  ctx: PluginRoutingStrategyContext
) => PluginRoutingStrategySelectorLike | Promise<PluginRoutingStrategySelectorLike>
