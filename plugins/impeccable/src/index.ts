/**
 * Impeccable — installable skill plugin, scaffolded by `cognia plugin import`.
 *
 * `skills` in plugin.json is registered by the host's overlay dispatch on
 * enable, so this entry carries no imperative registration. The manifest is
 * imported rather than restated so plugin.json stays the single source of
 * truth.
 *
 * Not bundled with the app: `build.mjs` compiles this file to
 * `dist/index.js` (the manifest's `main`, gitignored build output) and packs
 * the install ZIP. The desktop loader evaluates `main` as CommonJS, so the
 * plugin cannot load from its directory until that build has run — see the
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
