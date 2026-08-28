/**
 * Workflow-AI plugin — `wf_run_workflow_typed`: run a PUBLISHED workflow as a
 * typed callable unit (D5), the typed successor to `wf_run_workflow_by_name`.
 *
 * Where `wf_run_workflow_by_name` emits an A2UI Approve card for IM chats, this
 * tool is the desktop/agent path: it resolves a published workflow, validates
 * the caller's `input` against the declared input schema, runs the graph, and
 * returns the typed output (validated against the output schema). It is the
 * tool the model invokes when a graph-bodied skill (`kind:"workflow"`) is
 * relevant. `requiresApproval` is true — executing a workflow is side-effecting,
 * so the SDK pops the per-tool permission gate.
 *
 * The definition + execution live in `lib/workflow/publish/` (shared with the
 * skills→tools fallback that keeps graph-bodied skills callable even when this
 * plugin is disabled) — this file is only the plugin registration wrapper.
 */

import type { PluginTool } from "@cognia/plugin-sdk"
import {
  WORKFLOW_RUNNER_TOOL_NAME,
  WORKFLOW_RUNNER_TOOL_DEFINITION,
} from "@cognia/plugin-sdk/api/workflow-run"
import { executeRunWorkflowTyped } from "@cognia/plugin-sdk/api/workflow-run"
const PLUGIN_ID = "cognia-workflow-ai"

export function buildRunTypedTools(): PluginTool[] {
  return [
    {
      name: WORKFLOW_RUNNER_TOOL_NAME,
      pluginId: PLUGIN_ID,
      definition: WORKFLOW_RUNNER_TOOL_DEFINITION,
      execute: async (args) => executeRunWorkflowTyped(args),
    },
  ]
}
