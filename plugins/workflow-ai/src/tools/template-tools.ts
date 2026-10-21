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

import { definePluginTool, type PluginToolRegistration } from "@cognia/plugin-sdk"
import { formatToolError, getWorkflowApi, resolveStore } from "../store-bridge"
import type { CopilotSlotValues } from "@cognia/plugin-sdk/api/workflow-editor"
import { workflowEditorRevision } from "@cognia/plugin-sdk/api/workflow-editor"
import { summarizeOps, templateToProposalOps } from "@cognia/plugin-sdk/api/workflow-editor"

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  description:
    "Workflow id to target. Omit if exactly one editor is open and you want to act on it.",
} as const

function nextProposalId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function buildTemplateTools(): PluginToolRegistration[] {
  return [
    definePluginTool({
      name: "wf_list_templates",
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
          const templates = getWorkflowApi()
            .listCopilotTemplates()
            .map((t) => ({
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
    }),
    definePluginTool({
      name: "wf_apply_template",
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
          const materialize = getWorkflowApi().materializeCopilotTemplate(templateId, slots)
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
          const payload = getWorkflowApi().stageProposal({
            proposalId,
            workflowId,
            summary,
            ops,
            baseRevision: workflowEditorRevision(state),
          })
          return {
            ok: true,
            workflowId,
            proposalId: payload.proposalId,
            templateId: materialize.template.id,
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
    }),
  ]
}
