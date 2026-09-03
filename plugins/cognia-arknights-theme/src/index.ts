/**
 * Rhodes Operations appearance pack.
 *
 * All runtime behavior is intentionally declarative. The host's appearance
 * bridges register the complete theme palettes, bundled wallpapers, density
 * profiles, and theme packs from plugin.json on enable and remove them on
 * disable. Keeping this entry side-effect free preserves browser, Tauri, and
 * mobile parity.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import manifest from "../plugin.json"

const definition: PluginDefinition = {
  manifest: manifest as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("Rhodes Operations appearance contributions registered")
  },
  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger?.info("Rhodes Operations appearance contributions removed")
  },
}

export default definition
