/**
 * Plugin SDK — `density-preset` capability surface.
 *
 * Exports the authoring helper and the density-preset registry used by
 * plugin-contributed density settings. The host applies the active preset to
 * the DOM itself.
 */

export { defineDensityPreset } from "../define/define-density-preset"

export {
  getDensityPreset,
  listDensityPresets,
  registerDensityPreset,
  registerDensityPresetsForPlugin,
  subscribeDensityPresets,
  unregisterDensityPresetsByPlugin,
} from "@/lib/appearance/density-preset-registry"

export type { RegisteredDensityPreset } from "@/lib/appearance/density-preset-registry"

export type { DensityLevel, DensitySettings } from "@cognia/plugin-contract/types/appearance/index"
export type { PluginDensityPresetContribution } from "@cognia/plugin-contract/types/plugin/plugin"
