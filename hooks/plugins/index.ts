/**
 * Plugins hooks barrel.
 *
 * First-wave (M5B) hooks: live-query view-model, permission guard wrapper,
 * analytics aggregator, marketplace driver.
 * Later passes will add: use-plugin-config / use-plugin-scheduler /
 * use-plugin-updates / use-plugin-rollback / use-plugin-backup /
 * use-plugin-devtools.
 */

export { usePlugins, type PluginsView } from "./use-plugins"
export { PluginsViewProvider } from "./use-plugins-provider"
export { usePluginPermissions, type UsePluginPermissions } from "./use-plugin-permissions"
export {
  usePluginAnalytics,
  type UsePluginAnalytics,
  type PluginAnalyticsByPlugin,
} from "./use-plugin-analytics"
export {
  usePluginMarketplace,
  type UsePluginMarketplace,
  type PluginMarketplaceQueryState,
  type PluginMarketplaceEntry,
  __resetPluginMarketplaceClientForTests,
} from "./use-plugin-marketplace"
export {
  useOpenVsxMarketplace,
  toMarketplaceEntry,
  OPEN_VSX_SEARCH_DEBOUNCE_MS,
  type UseOpenVsxMarketplace,
  type OpenVsxMarketplaceEntry,
  type OpenVsxMarketplaceState,
} from "./use-openvsx-marketplace"
export {
  useBuiltinPluginEntries,
  mapBuiltinRowToEntry,
  type BuiltinMarketplaceEntry,
} from "./use-builtin-plugin-entries"
export { useDevtoolsGate } from "./use-devtools-gate"
export { usePiPackages, type UsePiPackagesResult } from "./use-pi-packages"
export { usePluginRow, type PluginRowState } from "./use-plugin-row"
export { usePluginDiagnostics } from "./use-plugin-diagnostics"
export {
  useWasmCapabilityGrant,
  type UseWasmCapabilityGrant,
  type RequestGrantArgs,
  type RequestGrantResult,
} from "./use-wasm-capability-grant"
export { usePluginRegistrySync, type PluginRegistrySync } from "./use-plugin-registry-sync"
