/**
 * New Eridu Signal appearance pack.
 *
 * Purely declarative: the host's appearance bridges register the theme
 * palette, bundled wallpapers, density profile and one-click theme packs from
 * plugin.json on enable and remove them on disable, so activate() has no work
 * to do. The packs never touch motion speed — that is the user's
 * accessibility preference, not part of a look.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: () => {},
})
