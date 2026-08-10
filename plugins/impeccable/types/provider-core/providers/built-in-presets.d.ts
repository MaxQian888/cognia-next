import { RoutingPreset, BuiltInPresetId } from "@cognia/provider-types/routing-presets"
import { CatalogRepository } from "./catalog-repository.js"
import "@cognia/provider-types/model-catalog"

declare function setPresetCatalogRepository(repository: CatalogRepository): void
declare const BUDGET_PRESET: RoutingPreset
declare const PERFORMANCE_PRESET: RoutingPreset
declare const RELIABILITY_PRESET: RoutingPreset
declare const BUILT_IN_PRESETS: RoutingPreset[]
declare function getBuiltInPreset(id: BuiltInPresetId): RoutingPreset | undefined
declare function adaptPresetToEnabledProviders(
  presetValue: RoutingPreset,
  enabledProviderIds: Set<string>,
  repository?: CatalogRepository | undefined
): RoutingPreset

export {
  BUDGET_PRESET,
  BUILT_IN_PRESETS,
  PERFORMANCE_PRESET,
  RELIABILITY_PRESET,
  adaptPresetToEnabledProviders,
  getBuiltInPreset,
  setPresetCatalogRepository,
}
