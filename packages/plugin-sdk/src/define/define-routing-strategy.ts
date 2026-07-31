/**
 * Plugin SDK helper for the `routing-strategy` capability.
 *
 * Pure typesafety pass-through for `manifest.routingStrategies[]` entries.
 */

import type { PluginRoutingStrategyDef } from "@/types/plugin/plugin-routing-strategy"

export function defineRoutingStrategy(def: PluginRoutingStrategyDef): PluginRoutingStrategyDef {
  return def
}
