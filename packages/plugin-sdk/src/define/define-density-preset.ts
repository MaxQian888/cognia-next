/**
 * Plugin SDK helper for the `density-preset` capability.
 *
 * Pure typesafety pass-through for `manifest.densityPresets[]` entries.
 */

import type { PluginDensityPresetContribution } from "@cognia/plugin-contract/types/plugin/index"

export function defineDensityPreset(
  preset: PluginDensityPresetContribution
): PluginDensityPresetContribution {
  return preset
}
