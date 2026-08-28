/**
 * Plugin SDK — `i18n` capability surface.
 *
 * `ctx.i18n` translates: it looks a key up in whatever bundles are loaded.
 * This module is the other half — how a plugin's own bundles GET loaded. A
 * plugin registers its messages at activation and the host merges them into
 * the lookup every surface uses, so a plugin-contributed string localizes the
 * same way a built-in one does.
 *
 * `unregisterPluginI18n(pluginId)` is the teardown, and the same call a
 * plugin's tests should use rather than reaching for host internals.
 */

export {
  getPluginI18nBundle,
  getPluginI18nSnapshot,
  inflateFlatKeys,
  lookupPluginMessage,
  registerPluginI18n,
  subscribeToPluginI18n,
  unregisterPluginI18n,
} from "@/lib/i18n/plugin-i18n-registry"

export type { LocaleCode, PluginI18nBundle } from "@/lib/i18n/plugin-i18n-registry"
