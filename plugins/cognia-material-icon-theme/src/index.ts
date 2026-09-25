/**
 * Material Icon Theme — a declarative, theme-only built-in.
 *
 * All of the work is done by the host from `plugin.json`: on enable, the
 * plugin manager hands `manifest.vscodeIconThemes` to the icons bridge
 * (`registerIconThemesForPlugin`), which reads `dist/material-icons.json`
 * through the `/plugins/cognia-material-icon-theme/` public mirror, and
 * `<FileTypeIcon>` renders the mirrored SVGs from then on. On disable the
 * manager unregisters the theme and the built-in lucide glyphs come back.
 *
 * The manifest declares no `activationEvents`, so the plugin is discovered on
 * every shell but stays off until the user enables it.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: () => {},
})
