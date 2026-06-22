/**
 * Plugin SDK — `theme` capability surface.
 *
 * Re-exports the authoring helper, plugin Theme API, themes bridge, and
 * runtime theme registry for plugin-contributed themes.
 */

export { defineTheme } from "../define/define-theme"

export { clearCustomThemesForPluginContext, createThemeAPI } from "@/lib/plugin/api/theme-api"

export { getPluginThemesBridge, PluginThemesBridge } from "@/lib/plugin/bridge/themes-bridge"

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
} from "@/lib/theme/theme-registry"

export type { PluginTheme } from "@/lib/theme/theme-registry"
export type { PluginThemeContribution } from "@/types/plugin/plugin"
export type {
  ColorThemePreset,
  CustomTheme,
  PluginThemeAPI,
  ThemeColors,
  ThemeMode,
  ThemeState,
} from "@/types/plugin/plugin-extended"
