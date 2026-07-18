/**
 * Workflow-AI plugin — template scaffolding tools (Phase E, Workflow
 * Copilot).
 *
 *   • wf_list_templates   — return the registered copilot templates with
 *                           slot metadata so the agent knows what to ask
 *                           the user (or pre-fill from prose).
 *   • wf_apply_template   — materialize a template + slot values into a
 *                           VisualWorkflow, convert into a proposal of
 *                           add_node + connect_edge ops, and stage it
 *                           via the proposal store. The chat surfaces
 *                           the same Apply / Discard card that
 *                           wf_propose_batch uses (single rendering
 *                           path).
 *
 * Template applications always go through the proposal flow — the user
 * sees the diff before commit, just like an AI-authored batch. The tool
 * never mutates the editor store directly.
 */

import type { PluginTool } from "@/types/plugin"
import type { VisualWorkflow, WorkflowNodeData, WorkflowNodeKind } from "@/types/workflow/visual"
import { formatToolError, resolveStore } from "../store-bridge"
import {
  getCopilotTemplate,
  listCopilotTemplates,
  materializeCopilotTemplate,
  type CopilotSlotValues,
} from "@/lib/workflow/copilot-templates"
import { useProposalStore } from "@/lib/workflow/editor/proposal-store"
import { workflowEditorRevision } from "@/lib/workflow/editor/editor-revision"
import { summarizeOps, type ProposalOp } from "@/lib/workflow/editor/proposal-types"

const PLUGIN_ID = "cognia-workflow-ai"

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  description:
    "Workflow id to target. Omit if exactly one editor is open and you want to act on it.",
} as const

/**
 * Convert a VisualWorkflow (produced by `template.build(slots)`) into an
 * ordered list of `add_node` + `connect_edge` ops suitable for the
 * proposal store. We re-id every node so the proposal IDs don't collide
 * with the current graph; edges are translated through the same map.
 */
export function templateToProposalOps(
  workflow: VisualWorkflow,
  existing: { nodeIds: Set<string>; edgeIds: Set<string> },
  reserveId: () => string
): { ops: ProposalOp[]; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {}
  const reservedNodes = new Set<string>(existing.nodeIds)
  const reservedEdges = new Set<string>(existing.edgeIds)

  function pickNodeId(seed: string): string {
    let id = `n_${seed}_${reserveId()}`
    while (reservedNodes.has(id)) id = `n_${seed}_${reserveId()}`
    reservedNodes.add(id)
    return id
  }
  function pickEdgeId(): string {
    let id = `e_${reserveId()}`
    while (reservedEdges.has(id)) id = `e_${reserveId()}`
    reservedEdges.add(id)
    return id
  }

  const ops: ProposalOp[] = []

  for (const node of workflow.nodes) {
    // Skip annotation-style nodes the template author may have included
    // for the seed flow — they're surface-only.
    const realId = pickNodeId(sanitizeForId(node.id))
    idMap[node.id] = realId
    const data: Partial<WorkflowNodeData> = {
      label: node.data.label,
      params: node.data.params,
      notes: node.data.notes,
      credentialRefs: node.data.credentialRefs,
      disabled: node.data.disabled,
      authoredBy: "ai",
    }
    ops.push({
      type: "add_node",
      nodeId: realId,
      kind: node.type as WorkflowNodeKind,
      position: node.position,
      data,
    })
  }

  for (const edge of workflow.edges) {
    const realSource = idMap[edge.source]
    const realTarget = idMap[edge.target]
    if (!realSource || !realTarget) {
      // Should never happen if the template author exports a self-contained
      // graph; we silently drop the dangling edge so the user can still
      // accept the partial proposal.
      continue
    }
    ops.push({
      type: "connect_edge",
      edgeId: pickEdgeId(),
      source: realSource,
      target: realTarget,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      label: edge.label,
    })
  }

  return { ops, idMap }
}

function sanitizeForId(raw: string): string {
  return (
    raw
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase()
      .slice(0, 24) || "node"
  )
}

function nextProposalId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function buildTemplateTools(): PluginTool[] {
  return [
    {
      name: "wf_list_templates",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_templates",
        description:
          "List the registered workflow copilot templates with their slot definitions. Use this BEFORE wf_apply_template to discover what the user can scaffold and which slots they need to fill (or what you can infer from prose).",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: { type: "object", properties: {} },
      },
      execute: async () => {
        try {
          const templates = listCopilotTemplates().map((t) => ({
            id: t.id,
            label: t.label,
            description: t.description,
            iconName: t.iconName,
            tags: t.tags ?? [],
            slots: t.slots.map((s) => ({
              key: s.key,
              type: s.type,
              label: s.label,
              description: s.description,
              placeholder: s.placeholder,
              options: s.options,
              required: !!s.required,
              defaultValue: s.defaultValue,
            })),
          }))
          return { ok: true, templates }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_apply_template",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_apply_template",
        description:
          "Materialize a workflow copilot template into a proposal — the user reviews and applies via the same diff card wf_propose_batch produces. Pass `slots` matching the template's declared keys (required ones must be filled; ones with defaultValue may be omitted). The tool does NOT mutate the canvas — the user clicks Apply.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["templateId"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            templateId: {
              type: "string",
              description: "id from wf_list_templates (e.g. 'github-pr', 'cron-report').",
            },
            slots: {
              type: "object",
              description:
                "Slot values keyed by slot.key. Strings or numbers — types must match the slot definition.",
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
          const templateId = String(args.templateId ?? "")
          const slots = (args.slots as CopilotSlotValues | undefined) ?? {}
          const materialize = materializeCopilotTemplate(templateId, slots)
          if (!materialize.ok) {
            return {
              ok: false,
              error: {
                code: materialize.code,
                message: materialize.message,
                detail:
                  materialize.code === "missing-required-slot"
                    ? { missing: materialize.missing }
                    : undefined,
              },
            }
          }
          const state = store.getState()
          const existing = {
            nodeIds: new Set(state.nodes.map((n) => n.id)),
            edgeIds: new Set(state.edges.map((e) => e.id)),
          }
          const { ops } = templateToProposalOps(materialize.workflow, existing, shortId)
          const proposalId = nextProposalId()
          const summary = `Apply template "${materialize.template.label.en}" — ${ops.filter((o) => o.type === "add_node").length} nodes`
          const payload = useProposalStore.getState().openProposal(workflowId, {
            proposalId,
            workflowId,
            summary,
            ops,
            baseRevision: workflowEditorRevision(state),
          })
          const template = getCopilotTemplate(templateId)
          return {
            ok: true,
            workflowId,
            proposalId: payload.proposalId,
            templateId: template?.id ?? templateId,
            summary: payload.summary,
            opCount: summarizeOps(ops),
            messageParts: [
              {
                type: "workflow-proposal",
                proposalId: payload.proposalId,
                workflowId: payload.workflowId,
                summary: payload.summary,
                ops: payload.ops,
                opCount: payload.opCount,
                baseRevision: payload.baseRevision,
              },
            ],
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
