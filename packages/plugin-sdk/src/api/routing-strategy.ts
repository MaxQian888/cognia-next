/**
 * Plugin SDK — `routing-strategy` capability surface.
 *
 * Re-exports the authoring helper, manifest bridge, and provider-routing
 * strategy overlay registry used by plugin-contributed selectors.
 */

export { defineRoutingStrategy } from "../define/define-routing-strategy"

export {
  registerRoutingStrategiesForPlugin,
  unregisterRoutingStrategiesForPlugin,
} from "@/lib/plugin/bridge/routing-strategies-bridge"

export type {
  RoutingStrategiesBridgeError,
  RoutingStrategiesBridgeOptions,
  RoutingStrategiesBridgeResult,
} from "@/lib/plugin/bridge/routing-strategies-bridge"

export {
  getRoutingStrategy,
  listRoutingStrategies,
  registerRoutingStrategy,
  unregisterRoutingStrategiesByPlugin,
  unregisterRoutingStrategy,
} from "@cognia/provider-routing/strategy-registry"

export type {
  PluginRoutingStrategyContext,
  PluginRoutingStrategyDef,
  PluginRoutingStrategyFactory,
  PluginRoutingStrategySelectorLike,
} from "@/types/plugin/plugin-routing-strategy"

export type {
  RoutingDecisionContext,
  RoutingStrategySelector,
  RoutingTelemetrySnapshot,
} from "@cognia/provider-types/routing-strategy"
