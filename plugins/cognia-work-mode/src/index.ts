/**
 * Work Mode — outcome-to-deliverable knowledge work.
 *
 * The mode, skills, specialist subagents, and team template ride the manifest
 * and are registered by the plugin manager on enable. `activate()` registers
 * only the four `work_*` tools, whose executors cannot live in JSON.
 *
 * In-flight review / parallel dispatch is cancelled through the activation's
 * lifecycle signal, which the host aborts before tearing the plugin down.
 */

import { definePlugin, definePluginManifest, type PluginContext } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { WORK_MODE } from "./mode"
import { WORK_SKILLS } from "./skills"
import { WORK_SUBAGENTS } from "./subagents"
import { KNOWLEDGE_WORK_TEAM } from "./team"
import { createWorkTools } from "./tools"

export const manifest = definePluginManifest({
  ...manifestJson,
  modes: [WORK_MODE],
  skills: WORK_SKILLS,
  subagents: WORK_SUBAGENTS,
  agentTeamTemplates: [KNOWLEDGE_WORK_TEAM],
})

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    for (const tool of createWorkTools(ctx, ctx.lifecycle.signal)) {
      ctx.agent.registerTool(tool)
    }
  },
})
