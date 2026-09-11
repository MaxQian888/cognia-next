import type { PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

// The installed manifest is also the module's single source of truth.
export const manifest = manifestJson as PluginManifest

const definition: PluginDefinition = {
  manifest,
  // The host registers declarative contributions and cleans them up on disable.
  activate: async () => {},
}

export default definition
