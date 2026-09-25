import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"

// plugin.json is the whole contribution surface: the service, its two MCP
// providers and their reviewed tool-risk overlays are all declarative, so
// activation has nothing to register imperatively.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: async () => {},
})
