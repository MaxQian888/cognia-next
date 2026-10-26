/**
 * Plugin SDK — `routing-strategy` capability surface.
 *
 * Exports the authoring helper and the provider-routing strategy overlay
 * registry used by plugin-contributed selectors. The host registers
 * manifest-declared strategies itself.
 */

export { defineRoutingStrategy } from "../define/define-routing-strategy"

export type {
  RoutingStrategiesBridgeError,
  RoutingStrategiesBridgeOptions,
  RoutingStrategiesBridgeResult,
} from "@cognia/plugin-contract/lib/plugin/bridge/routing-strategies-bridge"

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
} from "@cognia/plugin-contract/types/plugin/plugin-routing-strategy"

export type {
  RoutingDecisionContext,
  RoutingStrategySelector,
  RoutingTelemetrySnapshot,
} from "@cognia/provider-types/routing-strategy"
