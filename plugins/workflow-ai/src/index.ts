/**
 * Workflow-AI plugin — entry point.
 *
 * Activates a suite of MCP-bridged tools that let the chat agent inspect,
 * mutate, lay out, and run workflows. Tools are surfaced to the agent via the
 * `cognia-plugin-tools` MCP server (sidecar/builtin-tools/plugin-tools.mjs).
 *
 * The editing tools target the workflow open in the visual editor; if none is
 * open when one fires, it returns a typed `editor-not-open` error and the
 * agent can ask the user to open a workflow first. The run tools
 * (`wf_run_workflow_typed` / `wf_run_workflow_by_name` / `wf_list_workflows` /
 * `wf_emit_workflow_event`) work from any chat or IM session.
 *
 * All tools are registered for the life of the activation, including the
 * editor-only ones: the Plugin SDK exposes no editor open/close signal a
 * plugin could scope them to. The host removes a plugin's tools on disable.
 */

import { definePlugin, definePluginManifest, type PluginContext } from "@cognia/plugin-sdk"
import type { PluginToolRegistration } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { buildReadTools } from "./tools/read-tools"
import { buildMutateTools } from "./tools/mutate-tools"
import { buildLayoutTools } from "./tools/layout-tools"
import { buildRunTools } from "./tools/run-tools"
import { buildRunByNameTools, type WorkflowAiTranslate } from "./tools/run-by-name-tools"
import { buildRunTypedTools } from "./tools/run-typed-tools"
import { buildProposeTools } from "./tools/propose-tools"
import { buildTemplateTools } from "./tools/template-tools"
import { buildResourceTools } from "./tools/resource-tools"
import { buildNodeKindTools } from "./tools/node-kind-tools"
import { buildDiagnosticTools } from "./tools/diagnostic-tools"
import { buildWakeTools } from "./tools/wake-tools"
import { clearWorkflowApi, configureWorkflowApi } from "./store-bridge"

export const manifest = definePluginManifest(manifestJson)

export function buildWorkflowAiTools(
  workflow: PluginContext["workflow"],
  resources: PluginContext["resources"],
  t: WorkflowAiTranslate
): PluginToolRegistration[] {
  configureWorkflowApi(workflow)
  return [
    ...buildReadTools(),
    ...buildMutateTools(),
    ...buildProposeTools(),
    ...buildTemplateTools(),
    ...buildLayoutTools(),
    ...buildRunTools(),
    ...buildRunByNameTools(t),
    ...buildRunTypedTools(),
    ...buildResourceTools(resources),
    ...buildNodeKindTools(),
    ...buildDiagnosticTools(),
    ...buildWakeTools(),
  ]
}

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    const tools = buildWorkflowAiTools(ctx.workflow, ctx.resources, (key, params) =>
      ctx.i18n.t(key, params)
    )
    for (const tool of tools) ctx.agent.registerTool(tool)
    ctx.lifecycle.onDispose(clearWorkflowApi, "cognia-workflow-ai:workflow-api")
  },
})
