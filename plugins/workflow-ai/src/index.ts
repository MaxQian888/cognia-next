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
// ADR-0026 §5 §D — i18n is declared in `manifest.i18n` below and auto-
// wired by the plugin manager on enable. The old imperative
// `registerPluginI18n` / `unregisterPluginI18n` calls are gone.
import { buildReadTools } from "./tools/read-tools"
import { buildMutateTools } from "./tools/mutate-tools"
import { buildLayoutTools } from "./tools/layout-tools"
import { buildRunTools } from "./tools/run-tools"
import { buildRunByNameTools } from "./tools/run-by-name-tools"
import { buildRunTypedTools } from "./tools/run-typed-tools"
import { buildProposeTools } from "./tools/propose-tools"
import { buildTemplateTools } from "./tools/template-tools"
import { buildResourceTools } from "./tools/resource-tools"
import { buildNodeKindTools } from "./tools/node-kind-tools"
import { buildDiagnosticTools } from "./tools/diagnostic-tools"

const PLUGIN_ID = "cognia-workflow-ai"

export function buildWorkflowAiTools(): PluginTool[] {
  return [
    ...buildReadTools(),
    ...buildMutateTools(),
    ...buildProposeTools(),
    ...buildTemplateTools(),
    ...buildLayoutTools(),
    ...buildRunTools(),
    ...buildRunByNameTools(),
    ...buildRunTypedTools(),
    ...buildResourceTools(),
    ...buildNodeKindTools(),
    ...buildDiagnosticTools(),
  ]
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
    // ADR-0026 §5 §D — declarative i18n. Auto-wired on enable / disable.
    i18n: { locales: I18N_MESSAGES },
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("workflow-ai plugin activated")
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
      // i18n teardown handled by the manager (manifest.i18n path).
      if (ctx.agent?.unregisterTool) {
        for (const tool of buildWorkflowAiTools()) {
          ctx.agent.unregisterTool(tool.name)
        }
      }
    }
  },
}

export default definition
