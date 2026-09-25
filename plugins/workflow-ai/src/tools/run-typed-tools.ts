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

import { definePluginTool, type PluginToolRegistration } from "@cognia/plugin-sdk"
import { getWorkflowApi } from "../store-bridge"
import { WORKFLOW_RUN_TIMEOUT_MS } from "./run-tools"

export function buildRunTypedTools(): PluginToolRegistration[] {
  const runner = getWorkflowApi().getRunnerToolDefinition()
  return [
    definePluginTool({
      name: runner.name,
      // The shared runner definition carries no budget; a typed run waits for
      // the whole graph, so give it the same ceiling as wf_run_workflow.
      definition: { ...runner.definition, timeoutMs: WORKFLOW_RUN_TIMEOUT_MS },
      execute: async (args) => getWorkflowApi().executeRunWorkflowTyped(args),
    }),
  ]
}
