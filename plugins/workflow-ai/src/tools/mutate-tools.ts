/**
 * Workflow-AI plugin — graph mutation tools (Phase C, L2 tier).
 *
 * Every write goes through an existing store action (`addNode`,
 * `removeNodes`, `connect`, `removeEdges`, `updateNodeData`) so AI
 * edits and manual edits share one zundo history stack — Ctrl+Z
 * reverses AI work identically to typed-in changes.
 *
 * Tool surface:
 *   • wf_add_node              create a node at a position
 *   • wf_remove_node           delete one node + its incident edges
 *   • wf_connect_edge          connect source → target
 *   • wf_disconnect_edge       remove an edge by id
 *   • wf_configure_node        patch one node's data (label / params / notes / disabled)
 *   • wf_batch_apply           atomic sequence of any of the above (preferred for >2 ops)
 *
 * Approval: none. All edits land on the zundo stack and Ctrl+Z is
 * one keystroke away. The AI-authored badge (Phase E) marks the
 * touched nodes so the user can see what the assistant did.
 */

import type { PluginTool } from "@cognia/plugin-sdk"
import { formatToolError, resolveStore } from "../store-bridge"
import type { WorkflowNodeKind } from "@cognia/plugin-sdk"
import type { ProposalOp } from "@cognia/plugin-sdk/api/workflow-editor"
import { coerceProposalOp, KNOWN_PROPOSAL_OP_TYPES } from "@cognia/plugin-sdk/api/workflow-editor"
import { nanoid } from "nanoid"

const PLUGIN_ID = "cognia-workflow-ai"

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  description:
    "Workflow id to target. Omit if exactly one editor is open and you want to act on it.",
} as const

const POSITION_SCHEMA = {
  type: "object",
  required: ["x", "y"],
  properties: { x: { type: "number" }, y: { type: "number" } },
} as const

function markAuthoredByAi(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...patch, authoredBy: "ai" }
}

export function buildMutateTools(): PluginTool[] {
  return [
    {
      name: "wf_add_node",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_add_node",
        description:
          "Create a new node on the canvas at the given flow-space position. Returns the assigned id so subsequent connectEdge calls can reference it. Optional `data` patch sets label / params / notes / disabled at create time. Always stamps `authoredBy: 'ai'`.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["kind", "position"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            kind: {
              type: "string",
              description:
                "Node kind from the catalog (e.g. 'trigger.manual', 'ai.prompt', 'flow.branch'). Use wf_read_graph + the catalog to discover legal kinds.",
            },
            position: POSITION_SCHEMA,
            data: {
              type: "object",
              description:
                "Optional initial data: { label?, params?, notes?, disabled? }. Params shape depends on the node kind — match the inspector form.",
              additionalProperties: true,
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const pos = args.position as { x: number; y: number }
          const data = (args.data as Record<string, unknown> | undefined) ?? {}
          const id = store
            .getState()
            .addNode(args.kind as WorkflowNodeKind, pos, markAuthoredByAi(data))
          // Run validation so the inspector / corner badge updates
          // immediately — matches the post-edit UX of manual changes.
          store.getState().revalidateNode(id)
          return { ok: true, workflowId, nodeId: id }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_remove_node",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_remove_node",
        description:
          "Delete one node by id. The store also removes every edge incident to it. Undoable via Ctrl+Z.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["nodeId"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            nodeId: { type: "string" },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const nodeId = String(args.nodeId)
          if (!store.getState().nodes.some((node) => node.id === nodeId)) {
            return {
              ok: false,
              error: { code: "node-not-found", message: `Node "${nodeId}" does not exist.` },
            }
          }
          store.getState().removeNodes([nodeId])
          return { ok: true, workflowId, removed: 1 }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_connect_edge",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_connect_edge",
        description:
          "Connect a source node to a target node. Returns the new edge id. Optional handles let you pick which port to use when nodes expose multiple (e.g. flow.branch 'then'/'else').",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["source", "target"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            source: { type: "string" },
            target: { type: "string" },
            sourceHandle: { type: "string" },
            targetHandle: { type: "string" },
            label: { type: "string", description: "Optional edge label (e.g. 'true' / 'error')." },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const id = store.getState().connect({
            source: String(args.source),
            target: String(args.target),
            sourceHandle: args.sourceHandle as string | undefined,
            targetHandle: args.targetHandle as string | undefined,
          })
          if (!id) {
            return {
              ok: false,
              error: { code: "invalid-connection", message: "The requested edge is not valid." },
            }
          }
          if (typeof args.label === "string" && args.label.length > 0) {
            store.getState().updateEdgeData(id, { label: args.label })
          }
          return { ok: true, workflowId, edgeId: id }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_disconnect_edge",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_disconnect_edge",
        description: "Remove one edge by id. Undoable.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["edgeId"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            edgeId: { type: "string" },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const edgeId = String(args.edgeId)
          if (!store.getState().edges.some((edge) => edge.id === edgeId)) {
            return {
              ok: false,
              error: { code: "edge-not-found", message: `Edge "${edgeId}" does not exist.` },
            }
          }
          store.getState().removeEdges([edgeId])
          return { ok: true, workflowId, removed: 1 }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_configure_node",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_configure_node",
        description:
          "Patch one node's data: label, params, notes, disabled. Pass only the keys you want to change — others are left untouched. Triggers validation so the inspector badges update.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["nodeId", "patch"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            nodeId: { type: "string" },
            patch: {
              type: "object",
              description: "Partial node data: { label?, params?, notes?, disabled? }.",
              additionalProperties: true,
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const nodeId = String(args.nodeId)
          if (!store.getState().nodes.some((node) => node.id === nodeId)) {
            return {
              ok: false,
              error: { code: "node-not-found", message: `Node "${nodeId}" does not exist.` },
            }
          }
          const patch = (args.patch as Record<string, unknown>) ?? {}
          store.getState().updateNodeData(nodeId, markAuthoredByAi(patch))
          const result = store.getState().revalidateNode(nodeId)
          return { ok: true, workflowId, hasErrors: result.hasErrors }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_batch_apply",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_batch_apply",
        description:
          "Atomically apply a sequence of edits as one undoable operation. Each op is one of { type: 'add_node' | 'remove_node' | 'connect_edge' | 'disconnect_edge' | 'configure_node', ... } with the same fields as the single-op tools. Returns per-op results in order; any invalid op rejects the entire batch with no graph changes.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["ops"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            ops: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const ops = (args.ops as Array<Record<string, unknown>>) ?? []
          const proposalOps: ProposalOp[] = []
          const results: Array<Record<string, unknown>> = []
          for (let i = 0; i < ops.length; i++) {
            const op = ops[i]
            const type = String(op.type ?? "")
            if (!KNOWN_PROPOSAL_OP_TYPES.has(type)) {
              return {
                ok: false,
                error: { code: "unknown-op", message: `Unknown op type: "${type}"` },
                workflowId,
                applied: [],
                failedAt: i,
              }
            }
            const raw =
              type === "add_node"
                ? {
                    ...op,
                    nodeId:
                      typeof op.nodeId === "string" && op.nodeId.length > 0
                        ? op.nodeId
                        : `n_${nanoid(8)}`,
                    data: markAuthoredByAi((op.data as Record<string, unknown> | undefined) ?? {}),
                  }
                : type === "connect_edge"
                  ? {
                      ...op,
                      edgeId:
                        typeof op.edgeId === "string" && op.edgeId.length > 0
                          ? op.edgeId
                          : `e_${nanoid(8)}`,
                    }
                  : type === "configure_node"
                    ? {
                        ...op,
                        patch: markAuthoredByAi(
                          (op.patch as Record<string, unknown> | undefined) ?? {}
                        ),
                      }
                    : op
            const coerced = coerceProposalOp(raw, i)
            if (typeof coerced === "string") {
              return {
                ok: false,
                error: { code: "invalid-op", message: coerced },
                workflowId,
                applied: [],
                failedAt: i,
              }
            }
            proposalOps.push(coerced)
            switch (coerced.type) {
              case "add_node":
                results.push({ type, nodeId: coerced.nodeId })
                break
              case "remove_node":
              case "disconnect_edge":
                results.push({ type, removed: 1 })
                break
              case "connect_edge":
                results.push({ type, edgeId: coerced.edgeId })
                break
              case "configure_node":
                results.push({ type, nodeId: coerced.nodeId })
                break
            }
          }
          const applied = store.getState().applyProposalOps(proposalOps)
          if (applied.firstError) {
            const failedAt = Number(applied.firstError.match(/^op (\d+):/)?.[1] ?? 0)
            return {
              ok: false,
              error: { code: "op-failed", message: applied.firstError },
              workflowId,
              applied: [],
              failedAt,
            }
          }
          for (const result of results) {
            if (result.type !== "configure_node" || typeof result.nodeId !== "string") continue
            result.hasErrors = Boolean(store.getState().validationByStepId[result.nodeId])
            delete result.nodeId
          }
          return { ok: true, workflowId, applied: results }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
