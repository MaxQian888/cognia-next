/**
 * Appearance Demo — built-in reference plugin.
 *
 * Purely declarative: every contribution lives in `plugin.json` and is wired
 * by the host's appearance bridges on enable —
 *   - `themes[]`         → a complete CSS-variable palette (every token in the
 *                          host's theme catalog, so no surface falls back to
 *                          the base theme mid-screen),
 *   - `wallpapers[]`     → `wallpaper-bridge` → shows in the Wallpaper tab
 *                          (with a "Plugin" badge),
 *   - `densityPresets[]` → `density-preset-registry` → resolvable by name,
 *   - `themePacks[]`     → `theme-pack-registry` → shows in the Theme packs
 *                          tab; "Apply" runs `applyThemePack`, which resolves
 *                          the pack's `applies` map (host colour preset +
 *                          this plugin's wallpaper + named density + radius)
 *                          into appearance settings.
 *
 * The pack deliberately leaves `motionSpeed` out: motion speed is the user's
 * accessibility preference, and a look has no business changing it.
 *
 * There is no imperative work to do, so the plugin doubles as the smallest
 * possible "data-only contribution" example. It declares no activation
 * events: it stays off until the user enables it.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: () => {},
})
