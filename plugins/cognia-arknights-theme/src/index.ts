/**
 * Rhodes Operations appearance pack.
 *
 * All runtime behavior is intentionally declarative. The host's appearance
 * bridges register the complete theme palettes, bundled wallpapers, density
 * profiles, and theme packs from plugin.json on enable and remove them on
 * disable. Keeping this entry side-effect free preserves browser, Tauri, and
 * mobile parity. The packs never touch motion speed — that is the user's
 * accessibility preference, not part of a look.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: () => {},
})
