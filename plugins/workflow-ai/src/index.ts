/**
 * Workflow-AI plugin — entry point.
 *
 * Activates a suite of MCP-bridged tools that let the chat agent
 * inspect, mutate, lay out, and run the workflow currently open in the
 * editor. Tools are surfaced to the Claude Code SDK via the existing
 * `cognia-plugin-tools` MCP server (sidecar/builtin-tools/plugin-tools.mjs).
 *
 * Registration happens unconditionally on activate so a workflow-editor
 * chat session always has the tools available; if no editor is open
 * when a tool fires, the handler returns a typed `editor-not-open`
 * error and the agent can ask the user to open a workflow first.
 */

import type { PluginContext, PluginDefinition, PluginTool } from "@/types/plugin"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import { buildReadTools } from "./tools/read-tools"
import { buildMutateTools } from "./tools/mutate-tools"
import { buildLayoutTools } from "./tools/layout-tools"
import { buildRunTools } from "./tools/run-tools"

const PLUGIN_ID = "cognia-workflow-ai"

export function buildWorkflowAiTools(): PluginTool[] {
  return [...buildReadTools(), ...buildMutateTools(), ...buildLayoutTools(), ...buildRunTools()]
}

const I18N_MESSAGES = {
  en: {
    "plugin.workflow-ai.activated":
      "Workflow AI tools registered (read / mutate / layout / run). Open a workflow editor to use them.",
  },
  "zh-CN": {
    "plugin.workflow-ai.activated":
      "Workflow AI 工具已注册（读取 / 编辑 / 布局 / 运行）。打开一个工作流编辑器即可使用。",
  },
} as const

const definition: PluginDefinition = {
  manifest: {
    id: PLUGIN_ID,
    name: "Workflow AI",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "commands"],
    main: "src/index.ts",
    permissions: [],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("workflow-ai plugin activated")
    registerPluginI18n({ pluginId: PLUGIN_ID, messages: I18N_MESSAGES })
    if (ctx.agent?.registerTool) {
      for (const tool of buildWorkflowAiTools()) {
        ctx.agent.registerTool(tool)
      }
    } else {
      ctx.logger?.warn(
        "ctx.agent.registerTool unavailable — workflow-ai tools will not surface to chat"
      )
    }
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
      unregisterPluginI18n(ctx.pluginId)
      if (ctx.agent?.unregisterTool) {
        for (const tool of buildWorkflowAiTools()) {
          ctx.agent.unregisterTool(tool.name)
        }
      }
    }
  },
}

export default definition
