/**
 * Plugin SDK helper for the `external-agent-preset` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineExternalAgentPreset()` narrows the shape to `PluginExternalAgentPresetDef`
 * (an `ExternalAgentPresetConfig` plus a stable registry `id`) at authoring time.
 */

import type { PluginExternalAgentPresetDef } from "@/types/plugin"

export function defineExternalAgentPreset(
  def: PluginExternalAgentPresetDef
): PluginExternalAgentPresetDef {
  return def
}
