/**
 * Plugin SDK helper for AI provider contributions.
 *
 * Pure typesafety pass-through for `manifest.aiProviders[]` entries.
 */

import type { PluginAiProviderDef } from "@/types/plugin/plugin-ai-provider"

export function defineAiProvider(def: PluginAiProviderDef): PluginAiProviderDef {
  return def
}
