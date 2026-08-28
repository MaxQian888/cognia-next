/**
 * Workflow-AI plugin — diagnostic tools.
 *
 * `wf_explain_validation` turns the editor's per-node validation map
 * into ready-to-act issues (severity + suggestion + jumpToNodeId).
 *
 * `wf_explain_last_run` summarises the most recent run with the
 * focal-failure step pinpointed.
 *
 * Both are read-only and never require approval. They lean on the
 * pure-function `lib/workflow/runtime/error-explainer.ts` so the
 * mapping logic stays trivially unit-testable.
 */

import type { PluginTool } from "@cognia/plugin-sdk"
import { formatToolError, resolveStore } from "../store-bridge"
import { explainLastRun, explainValidation } from "@cognia/plugin-sdk/api/workflow-editor"
const PLUGIN_ID = "cognia-workflow-ai"

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  description:
    "Workflow id to target. Omit if exactly one editor is open and you want to act on it.",
} as const

export function buildDiagnosticTools(): PluginTool[] {
  return [
    {
      name: "wf_explain_validation",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_explain_validation",
        description:
          "Explain every blocking validation error on the current canvas as { nodeId, nodeLabel, nodeKind, message, fields, severity, blocking, suggestion, jumpToNodeId }. Empty list means the graph is runnable. Prefer this over wf_get_validation_errors when you want to phrase fixes for the user.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: { workflowId: WORKFLOW_ID_SCHEMA },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const s = store.getState()
          const nodes = s.nodes.map((n) => ({
            id: n.id,
            label: n.data.label ?? n.id,
            kind: n.data.kind,
          }))
          const issues = explainValidation(s.validationByStepId, nodes)
          return { ok: true, workflowId, issues }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_explain_last_run",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_explain_last_run",
        description:
          "Summarise the most recent run: { status: 'no-run'|'succeeded'|'partial'|'failed', failedStepId?, failedStepLabel?, errorSummary?, suggestion?, jumpToNodeId?, counts:{succeeded,failed,skipped} }. Use BEFORE proposing a fix when the user asks 'why did it fail?'.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: { workflowId: WORKFLOW_ID_SCHEMA },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const s = store.getState()
          const nodes = s.nodes.map((n) => ({
            id: n.id,
            label: n.data.label ?? n.id,
            kind: n.data.kind,
          }))
          const report = explainLastRun(s.lastRunByStepId, nodes)
          return { ok: true, workflowId, ...report }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
