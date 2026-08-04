import type { PluginContext, PluginDefinition, PluginManifest } from "@/types/plugin"
import manifestJson from "../plugin.json"
import { PLUGIN_ID } from "./ids"
import { SRE_SUBAGENTS } from "./subagents"
import { createSreTools } from "./tools"
import type { SrePluginContext } from "./runtime"

let lifecycleController: AbortController | undefined

export const manifest: PluginManifest = {
  ...(manifestJson as unknown as PluginManifest),
  id: PLUGIN_ID,
  subagents: SRE_SUBAGENTS,
}

const definition: PluginDefinition = {
  manifest,
  activate: async (ctx: PluginContext) => {
    lifecycleController?.abort()
    lifecycleController = new AbortController()
    for (const tool of createSreTools(
      ctx as unknown as SrePluginContext,
      lifecycleController.signal
    )) {
      ctx.agent.registerTool(tool)
    }
    ctx.logger?.info("sre-agent plugin activated")
  },
  deactivate: async () => {
    lifecycleController?.abort()
    lifecycleController = undefined
  },
}

export default definition
