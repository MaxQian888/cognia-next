/**
 * Plugin SDK — `theme` capability surface.
 *
 * Exports the authoring helper, the types of `ctx.theme`, and the runtime
 * theme registry for plugin-contributed themes. The host builds `ctx.theme`
 * and bridges manifest themes itself.
 */

export { defineTheme } from "../define/define-theme"

export type {
  ThemesBridgeError,
  ThemesBridgeRegisterResult,
} from "@/lib/plugin/bridge/themes-bridge"

export {
  getPluginTheme,
  listPluginThemes,
  registerPluginTheme,
  subscribeThemeRegistry,
  unregisterPluginTheme,
  unregisterThemesByPlugin,
} from "@cognia/plugin-contract/lib/theme/theme-registry"

export type { PluginTheme } from "@cognia/plugin-contract/lib/theme/theme-registry"
export type { PluginThemeContribution } from "@cognia/plugin-contract/types/plugin/plugin"
export type {
  ColorThemePreset,
  CustomTheme,
  PluginThemeAPI,
  ThemeColors,
  ThemeMode,
  ThemeState,
} from "@cognia/plugin-contract/types/plugin/plugin"
