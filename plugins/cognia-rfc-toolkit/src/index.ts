/**
 * cognia-rfc-toolkit — declarative, installable skill plugin.
 *
 * All contributions (three local-bundle skills) are declared in plugin.json and registered by the
 * host's overlay dispatch on enable, so this entry carries no imperative
 * registration. The manifest is imported rather than restated so plugin.json
 * stays the single source of truth.
 *
 * Not bundled with the app: `cognia plugin build` compiles this file to
 * `dist/index.js` (the manifest's `main`) and packs the install ZIP — see the
 * README.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  // Everything is declarative; activation has no work to do.
  activate: async () => {},
})
