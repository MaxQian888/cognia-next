import type { PluginContext, PluginDefinition, PluginManifest } from "@/types/plugin"
import manifestJson from "../plugin.json"
import { PLUGIN_ID } from "./ids"
import { WORK_MODE } from "./mode"
import { WORK_SKILLS } from "./skills"
import { WORK_SUBAGENTS } from "./subagents"
import { KNOWLEDGE_WORK_TEAM } from "./team"
import { createWorkTools } from "./tools"
import type { WorkPluginContext } from "./runtime"

let lifecycleController: AbortController | undefined

export const manifest: PluginManifest = {
  ...(manifestJson as unknown as PluginManifest),
  id: PLUGIN_ID,
  modes: [WORK_MODE],
  skills: WORK_SKILLS,
  subagents: WORK_SUBAGENTS,
  agentTeamTemplates: [KNOWLEDGE_WORK_TEAM],
}

const definition: PluginDefinition = {
  manifest,
  activate: async (ctx: PluginContext) => {
    lifecycleController?.abort()
    lifecycleController = new AbortController()
    for (const tool of createWorkTools(
      ctx as unknown as WorkPluginContext,
      lifecycleController.signal
    )) {
      ctx.agent.registerTool(tool)
    }
    ctx.logger?.info("work-mode plugin activated")
  },
  deactivate: async () => {
    lifecycleController?.abort()
    lifecycleController = undefined
  },
}

export default definition
