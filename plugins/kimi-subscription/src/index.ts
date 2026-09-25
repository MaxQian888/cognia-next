import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

// The installed manifest is also the module's single source of truth.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  // The host registers declarative contributions and cleans them up on disable.
  activate: async () => {},
})
