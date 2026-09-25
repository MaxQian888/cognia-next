/**
 * Plugin SDK helper for decision provider contributions (ADR-0194).
 *
 * Pure typesafety pass-through for `manifest.decisionProviders[]` entries.
 */

import type { PluginDecisionProviderDef } from "@/types/plugin/plugin-decisions"

export function defineDecisionProvider(def: PluginDecisionProviderDef): PluginDecisionProviderDef {
  return def
}
