/**
 * Plugin SDK helper for the `compaction-strategy` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineCompactionStrategy()` checks the shape against
 * `PluginCompactionStrategyDef` (id + the summary-prompt / keep-recent /
 * fraction tuning a custom context-compaction strategy declares).
 */

import type { PluginCompactionStrategyDef } from "@/types/plugin/plugin-compaction-strategy"

export function defineCompactionStrategy(
  def: PluginCompactionStrategyDef
): PluginCompactionStrategyDef {
  return def
}
