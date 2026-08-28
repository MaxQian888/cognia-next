import type { PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"

export const manifest = manifestJson as unknown as PluginManifest

const definition: PluginDefinition = {
  manifest,
  activate: async () => {},
}

export default definition
