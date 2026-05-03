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
