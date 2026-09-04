import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import manifest from "../plugin.json"

const definition: PluginDefinition = {
  manifest: manifest as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("Seven Nations appearance contributions registered")
  },
  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger?.info("Seven Nations appearance contributions removed")
  },
}

export default definition
