/**
 * Plugin SDK — `theme-pack` capability surface.
 *
 * Re-exports the authoring helper and theme-pack registry used by
 * plugin-contributed appearance bundles.
 */

export { defineThemePack } from "../define/define-theme-pack"

export {
  getThemePack,
  listThemePacks,
  registerThemePack,
  subscribeThemePackRegistry,
  unregisterThemePack,
  unregisterThemePacksByPlugin,
} from "@/lib/theme/theme-pack-registry"

export type { RegisteredThemePack } from "@/lib/theme/theme-pack-registry"
export type { PluginThemePackContribution } from "@/types/plugin/plugin"
