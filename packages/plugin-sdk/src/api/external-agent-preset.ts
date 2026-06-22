/**
 * Plugin SDK - `external-agent-preset` capability surface.
 *
 * Re-exports the declarative authoring helper and aliases the host dynamic
 * preset overlay with explicit external-agent names.
 */

export { defineExternalAgentPreset } from "../define/define-external-agent-preset"

export {
  createAgentFromPreset,
  EXTERNAL_AGENT_PRESETS,
  getDynamicPresetEntry as getDynamicExternalAgentPresetEntry,
  getAvailablePresets as listExternalAgentPresetIds,
  getPresetConfig as getExternalAgentPresetConfig,
  getPresetDisplayInfo as getExternalAgentPresetDisplayInfo,
  isFromPreset,
  listDynamicPresetEntries as listDynamicExternalAgentPresetEntries,
  registerPreset as registerExternalAgentPreset,
  resolvePreferredCodexExecutablePresetId,
  unregisterPreset as unregisterExternalAgentPreset,
  unregisterPresetsByPlugin as unregisterExternalAgentPresetsByPlugin,
} from "@/lib/ai/agent/external/presets"

export type {
  ExternalAgentPresetConfig,
  ExternalAgentPresetId,
} from "@/lib/ai/agent/external/presets"

export type { PluginExternalAgentPresetDef } from "@/types/plugin"
