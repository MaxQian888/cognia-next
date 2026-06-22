/**
 * Plugin SDK — `density-preset` capability surface.
 *
 * Re-exports the authoring helper, density-preset registry, and applier
 * helpers used by plugin-contributed density settings.
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

export {
  applyDensityPresetVars,
  clearDensityPresetVars,
  densitySurfaceProps,
  resolveDensityAttrs,
} from "@/lib/appearance/density-applier"

export type { DensityLevel, DensitySettings } from "@/types/appearance"
export type { PluginDensityPresetContribution } from "@/types/plugin/plugin"
