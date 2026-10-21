/**
 * Plugin SDK — `wallpaper` capability surface.
 *
 * Re-exports the authoring helper and wallpaper bridge registry used by
 * plugin-contributed bundled wallpapers.
 */

export { defineWallpaper } from "../define/define-wallpaper"

export {
  applyPluginWallpapers,
  contributionToWallpaper,
  listPluginWallpapers,
  revertPluginWallpapers,
  subscribePluginWallpapers,
} from "@cognia/plugin-contract/lib/plugin/bridge/wallpaper-bridge"

export type {
  ApplyPluginWallpapersArgs,
  ApplyPluginWallpapersResult,
  RegisteredPluginWallpaper,
  WallpaperAssetResolver,
} from "@cognia/plugin-contract/lib/plugin/bridge/wallpaper-bridge"

export type { PluginWallpaperContribution } from "@cognia/plugin-contract/types/plugin/plugin"
export type { Wallpaper } from "@cognia/plugin-contract/types/appearance/index"
