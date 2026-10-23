/**
 * Plugin SDK helper for the `routing-strategy` capability.
 *
 * Pure typesafety pass-through for `manifest.routingStrategies[]` entries.
 */

import type { PluginRoutingStrategyDef } from "@cognia/plugin-contract/types/plugin/plugin-routing-strategy"

export function defineRoutingStrategy(def: PluginRoutingStrategyDef): PluginRoutingStrategyDef {
  return def
}
