/**
 * Appearance Demo — built-in reference plugin.
 *
 * Purely declarative: every contribution lives in `plugin.json` and is wired
 * by the host's appearance bridges on enable —
 *   - `wallpapers[]`     → `wallpaper-bridge` → shows in the Wallpaper tab
 *                          (with a "Plugin" badge),
 *   - `densityPresets[]` → `density-preset-registry` → resolvable by name,
 *   - `themePacks[]`     → `theme-pack-registry` → shows in the Theme packs
 *                          tab; "Apply" runs `applyThemePack`, which resolves
 *                          the pack's `applies` map (host colour preset +
 *                          this plugin's wallpaper + named density + radius +
 *                          motion) into appearance settings.
 *
 * There is no imperative work to do — the lifecycle hooks only log, so the
 * plugin doubles as the smallest possible "data-only contribution" example.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import manifest from "../plugin.json"

const definition: PluginDefinition = {
  manifest: manifest as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("appearance-demo activated (declarative contributions wired by host bridges)")
  },
  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger?.info("appearance-demo deactivated")
  },
}

export default definition
