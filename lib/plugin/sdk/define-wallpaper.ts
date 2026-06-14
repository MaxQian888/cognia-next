/**
 * Plugin SDK helper for bundled wallpapers (ADR-0029).
 *
 * Pure typesafety pass-through — wrapping a wallpaper in `defineWallpaper()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `PluginWallpaperContribution` (a bundled image / gradient / color
 * surfaced in the wallpaper picker by the wallpaper bridge).
 *
 * Usage:
 *   const aurora = defineWallpaper({
 *     id: "demo-aurora",
 *     name: "Aurora",
 *     source: { kind: "gradient", css: "linear-gradient(...)" },
 *   })
 */

import type { PluginWallpaperContribution } from "@/types/plugin"

export function defineWallpaper(
  wallpaper: PluginWallpaperContribution
): PluginWallpaperContribution {
  return wallpaper
}
