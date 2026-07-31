/**
 * Workflow-AI plugin — layout + selection tools (Phase C, L2 tier).
 *
 *   • wf_auto_layout        elkjs-based re-layout of the entire graph
 *   • wf_group_nodes        wrap the given node ids in an annotation.group frame
 *   • wf_select_nodes       set selection (so the inspector shows a particular node)
 *   • wf_focus_viewport     pan / zoom to a node or rectangle
 *
 * Approval: none. Layout / selection / viewport are non-destructive
 * (auto-layout updates node positions but the user can Ctrl+Z).
 */

import type { PluginTool } from "@/types/plugin"
import {
  autoLayout,
  applyAutoLayoutPositions,
  ELK_DIRECTIONS,
  type AutoLayoutDirection,
} from "@/lib/workflow/editor/auto-layout"
import { formatToolError, resolveStore } from "../store-bridge"

const PLUGIN_ID = "cognia-workflow-ai"

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  description:
    "Workflow id to target. Omit if exactly one editor is open and you want to act on it.",
} as const

export function buildLayoutTools(): PluginTool[] {
  return [
    {
      name: "wf_auto_layout",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_auto_layout",
        description:
          "Re-layout the entire graph using elkjs (left→right by default). Updates every node's position in one undoable batch. Use after a sequence of add_node / connect_edge ops to tidy the result.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            direction: {
              type: "string",
              enum: ["LR", "TB", "RL", "BT"],
              description: "Edge routing direction: LR (default), TB, RL, BT.",
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const state = store.getState()
          // `direction` is part of the schema, i.e. a contract with the model —
          // it used to be `void`ed, so asking for TB silently produced LR and
          // still answered `{ ok: true }`. `autoLayout` now maps it onto
          // `elk.direction`.
          const direction =
            typeof args.direction === "string" && args.direction in ELK_DIRECTIONS
              ? (args.direction as AutoLayoutDirection)
              : undefined
          const layoutResult = await autoLayout(state.nodes, state.edges, { direction })
          const next = applyAutoLayoutPositions(state.nodes, layoutResult)
          state.setNodes(next)
          return { ok: true, workflowId, repositioned: next.length }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_group_nodes",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_group_nodes",
        description:
          "Wrap the given node ids in an `annotation.group` frame sized to their bounding box. Returns the new group node's id (or null if the input was empty or the nodes weren't found).",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["nodeIds"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            nodeIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const ids = ((args.nodeIds as unknown[]) ?? []).map(String)
          const groupId = store.getState().groupSelected(ids)
          return { ok: true, workflowId, groupId }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_select_nodes",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_select_nodes",
        description:
          "Set the canvas selection to the given node ids. The Inspector tab auto-switches to show the first selected node so the user can see what the AI picked. Pass an empty array to clear selection.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["nodeIds"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            nodeIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const ids = ((args.nodeIds as unknown[]) ?? []).map(String)
          store.getState().setSelectedNodes(ids)
          return { ok: true, workflowId, selected: ids.length }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_focus_viewport",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_focus_viewport",
        description:
          "Pan and zoom the canvas to focus on a node id or an explicit viewport. Use to draw the user's attention to nodes you just edited.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            nodeId: {
              type: "string",
              description: "Focus on this node id (centered, zoom 1).",
            },
            viewport: {
              type: "object",
              description: "Or supply an explicit viewport { x, y, zoom }.",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                zoom: { type: "number" },
              },
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const state = store.getState()
          if (typeof args.nodeId === "string") {
            const node = state.nodes.find((n) => n.id === args.nodeId)
            if (!node) {
              return {
                ok: false,
                error: { code: "node-not-found", message: `No node "${args.nodeId}".` },
              }
            }
            state.setViewport({ x: -node.position.x + 400, y: -node.position.y + 200, zoom: 1 })
            // Pulse so the user sees what we focused on. 1.5s is the
            // default elsewhere in the editor (spotlight search).
            state.pulseNode(node.id, 1500)
            return { ok: true, workflowId, focused: node.id }
          }
          if (args.viewport && typeof args.viewport === "object") {
            const vp = args.viewport as { x?: number; y?: number; zoom?: number }
            state.setViewport({
              x: typeof vp.x === "number" ? vp.x : state.viewport.x,
              y: typeof vp.y === "number" ? vp.y : state.viewport.y,
              zoom: typeof vp.zoom === "number" ? vp.zoom : state.viewport.zoom,
            })
            return { ok: true, workflowId, viewport: state.viewport }
          }
          return {
            ok: false,
            error: { code: "missing-target", message: "Supply nodeId or viewport." },
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
