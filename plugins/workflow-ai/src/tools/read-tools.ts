/**
 * Workflow-AI plugin — read-only tools (Phase C, L1 tier).
 *
 * These never mutate the editor store. The workflow agent uses them to
 * answer "what's on the canvas?", "why is this node failing?", and to
 * ground subsequent mutation calls in actual graph state.
 *
 * Tool surface:
 *   • readGraph              entire graph as a compact JSON snapshot
 *   • readSelection          ids of currently-selected nodes + edges
 *   • readNode               one node's full data (label / kind / params / etc.)
 *   • getValidationErrors    per-node validation issues (only failing nodes)
 *   • getLastRun             aggregated outcome of each step's most recent run
 *
 * Approval: never. Reads are safe and idempotent.
 */

import type { PluginTool } from "@/types/plugin"
import { formatToolError, resolveStore } from "../store-bridge"

const PLUGIN_ID = "cognia-workflow-ai"

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  description:
    "Workflow id to target. Omit if exactly one editor is open and you want to act on it.",
} as const

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

export function buildReadTools(): PluginTool[] {
  return [
    {
      name: "wf_read_graph",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_read_graph",
        description:
          "Read the full graph of the targeted workflow as a structured JSON: nodes (id, kind, label, position, params, disabled, notes, authoredBy), edges (id, source, target, sourceHandle, targetHandle, label, data), and envelope (id, name, description). Use BEFORE any mutation call so subsequent ids and positions are grounded in the actual canvas.",
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
          return {
            ok: true,
            workflowId,
            envelope: {
              id: s.baseWorkflow.id,
              name: s.baseWorkflow.name,
              description: s.baseWorkflow.description,
              tags: s.baseWorkflow.tags ?? [],
            },
            viewport: s.viewport,
            nodes: s.nodes.map((n) => ({
              id: n.id,
              kind: n.data.kind,
              label: n.data.label,
              position: n.position,
              params: n.data.params ?? {},
              disabled: n.data.disabled ?? false,
              notes: n.data.notes,
              authoredBy: n.data.authoredBy,
            })),
            edges: s.edges.map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle,
              targetHandle: e.targetHandle,
              label: e.label,
              data: e.data,
            })),
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_read_selection",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_read_selection",
        description:
          "Return the ids of nodes and edges the user currently has selected on the canvas. Useful for 'wrap the selection in a retry loop'-style asks.",
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
          return {
            ok: true,
            workflowId,
            selectedNodeIds: s.selectedNodeIds,
            selectedEdgeIds: s.selectedEdgeIds,
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_read_node",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_read_node",
        description:
          "Read one node's full state: kind, label, position, params, disabled, notes, validation errors (if any), last-run status (if any). Returns ok:false with code 'node-not-found' if the id is unknown.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["nodeId"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            nodeId: { type: "string", description: "The node id to read." },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const nodeId = String(args.nodeId)
          const s = store.getState()
          const node = s.nodes.find((n) => n.id === nodeId)
          if (!node) {
            return { ok: false, error: { code: "node-not-found", message: `No node "${nodeId}".` } }
          }
          return {
            ok: true,
            workflowId,
            node: {
              id: node.id,
              kind: node.data.kind,
              label: node.data.label,
              position: node.position,
              params: asRecord(node.data.params),
              disabled: node.data.disabled ?? false,
              notes: node.data.notes,
              authoredBy: node.data.authoredBy,
              runStatus: s.runStatusByStepId[nodeId],
              validation: s.validationByStepId[nodeId] ?? null,
              lastRun: s.lastRunByStepId[nodeId] ?? null,
            },
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_get_validation_errors",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_get_validation_errors",
        description:
          "List every node currently failing parameter validation, with per-field error keys and a short summary. Empty list means the graph is in a runnable state. Call this before runWorkflow to anticipate the same gate the Run button enforces.",
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
          const failing = Object.entries(s.validationByStepId).map(([nodeId, result]) => ({
            nodeId,
            label: s.nodes.find((n) => n.id === nodeId)?.data.label ?? nodeId,
            kind: s.nodes.find((n) => n.id === nodeId)?.data.kind ?? "unknown",
            summary: result.summary,
            fieldKeys: Object.keys(result.fields),
          }))
          return { ok: true, workflowId, failing }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_get_last_run",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_get_last_run",
        description:
          "Return the aggregated outcome (succeeded / failed / skipped, durationMs, attempt, errorMessage) for each step's MOST RECENT terminal event across all runs of this workflow. Use to diagnose failures or summarize 'what happened on the last run'.",
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
          return {
            ok: true,
            workflowId,
            lastRunByStepId: s.lastRunByStepId,
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
