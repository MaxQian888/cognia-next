/**
 * Workflow-AI plugin — propose-batch tool (Phase E, Workflow Copilot).
 *
 * `wf_propose_batch` stages a multi-op graph change in the proposal store
 * without touching the editor. The chat surfaces it as an inline diff card
 * (Apply / Discard) — apply hands the ops to the editor's
 * `applyProposalOps` action in a single zundo entry; discard wipes the
 * proposal. This is the path the Workflow Copilot uses for any plan with
 * 2+ ops; single-op edits stay on the direct `wf_add_node` /
 * `wf_configure_node` path because Ctrl+Z is already one keystroke away.
 *
 * Pre-flight validation rejects:
 *   • duplicate node/edge ids (between ops, or against the existing graph)
 *   • connect_edge / configure_node / remove_node / disconnect_edge ids
 *     that reference nothing
 *   • unknown op `type` values
 *
 * The tool DOES NOT mutate the canvas — the proposal stays staged until
 * the user clicks Apply on the rendered card.
 */

import type { PluginTool } from "@cognia/plugin-sdk"
import { formatToolError, getWorkflowApi, resolveStore } from "../store-bridge"
import type { ProposalPayload } from "@cognia/plugin-sdk/api/workflow-editor"
import { summarizeOps, type ProposalOp } from "@cognia/plugin-sdk/api/workflow-editor"
import { coerceProposalOp } from "@cognia/plugin-sdk/api/workflow-editor"
import { workflowEditorRevision } from "@cognia/plugin-sdk/api/workflow-editor"
const PLUGIN_ID = "cognia-workflow-ai"

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  description:
    "Workflow id to target. Omit if exactly one editor is open and you want to act on it.",
} as const

const PROPOSAL_OP_SCHEMA = {
  type: "object",
  required: ["type"],
  description:
    "One of: { type: 'add_node', nodeId, kind, position, data? } | { type: 'remove_node', nodeId } | { type: 'connect_edge', edgeId, source, target, sourceHandle?, targetHandle?, label? } | { type: 'disconnect_edge', edgeId } | { type: 'configure_node', nodeId, patch }.",
  additionalProperties: true,
} as const

export interface ProposeBatchToolResult {
  ok: boolean
  workflowId?: string
  proposalId?: string
  summary?: string
  opCount?: ReturnType<typeof summarizeOps>
  baseRevision?: string
  error?: { code: string; message: string; detail?: unknown }
  /**
   * The renderer side picks this up via the chat message-part renderer
   * (registered in the plugin's `activate`). Surfaced INSIDE the tool
   * result so the proposal card appears in the same chat turn as the
   * agent's prose summary.
   */
  messageParts?: Array<{
    type: "workflow-proposal"
    proposalId: string
    workflowId: string
    summary: string
    ops: ReadonlyArray<ProposalOp>
    opCount: ReturnType<typeof summarizeOps>
    baseRevision: string
  }>
}

/**
 * Cross-op + against-current-graph validation. Returns a string error
 * if any id collision or dangling reference is detected; null on success.
 */
export function validateProposalOps(
  ops: ReadonlyArray<ProposalOp>,
  existing: { nodeIds: Set<string>; edgeIds: Set<string> }
): string | null {
  // Track ids the batch INTRODUCES so subsequent ops can reference them
  // even though the editor store hasn't seen them yet.
  const introducedNodes = new Set<string>()
  const introducedEdges = new Set<string>()
  // Track ids the batch REMOVES so subsequent ops can't reference them.
  const removedNodes = new Set<string>()
  const removedEdges = new Set<string>()

  const nodeAvailable = (id: string): boolean => {
    if (removedNodes.has(id)) return false
    if (introducedNodes.has(id)) return true
    return existing.nodeIds.has(id)
  }
  const edgeAvailable = (id: string): boolean => {
    if (removedEdges.has(id)) return false
    if (introducedEdges.has(id)) return true
    return existing.edgeIds.has(id)
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    switch (op.type) {
      case "add_node":
        if (introducedNodes.has(op.nodeId) || existing.nodeIds.has(op.nodeId)) {
          return `op ${i}: node id "${op.nodeId}" already exists`
        }
        introducedNodes.add(op.nodeId)
        break
      case "remove_node":
        if (!nodeAvailable(op.nodeId))
          return `op ${i}: remove_node references unknown node id "${op.nodeId}"`
        removedNodes.add(op.nodeId)
        introducedNodes.delete(op.nodeId)
        break
      case "connect_edge":
        if (introducedEdges.has(op.edgeId) || existing.edgeIds.has(op.edgeId)) {
          return `op ${i}: edge id "${op.edgeId}" already exists`
        }
        if (!nodeAvailable(op.source))
          return `op ${i}: connect_edge source "${op.source}" does not exist`
        if (!nodeAvailable(op.target))
          return `op ${i}: connect_edge target "${op.target}" does not exist`
        introducedEdges.add(op.edgeId)
        break
      case "disconnect_edge":
        if (!edgeAvailable(op.edgeId))
          return `op ${i}: disconnect_edge references unknown edge id "${op.edgeId}"`
        removedEdges.add(op.edgeId)
        introducedEdges.delete(op.edgeId)
        break
      case "configure_node":
        if (!nodeAvailable(op.nodeId))
          return `op ${i}: configure_node references unknown node id "${op.nodeId}"`
        break
    }
  }
  return null
}

function nextProposalId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function buildProposeTools(): PluginTool[] {
  return [
    {
      name: "wf_propose_batch",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_propose_batch",
        description:
          "Stage a batch of graph mutations as a proposal that the user reviews via an inline Apply / Discard card. Use this for ANY plan with 2+ ops (single ops can still commit directly via wf_add_node / wf_configure_node etc.). The tool does NOT mutate the canvas — apply happens when the user clicks Apply. Returns a proposalId, summary, and structured opCount; the chat message-part renderer surfaces the diff card from the same tool result.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["ops", "summary"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            summary: {
              type: "string",
              description:
                "Plain-English one-line summary surfaced as the proposal card heading. Be specific: 'Add parallel correctness + security analysts after Prepare' beats 'Add nodes'.",
            },
            ops: {
              type: "array",
              minItems: 1,
              items: PROPOSAL_OP_SCHEMA,
              description:
                "Ordered list of mutations. add_node ids are referenced by subsequent connect_edge / configure_node ops in the SAME batch — supply ids you control (e.g. 'n_analyst_correctness') so your prose can cite them.",
            },
          },
        },
      },
      execute: async (args): Promise<ProposeBatchToolResult> => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const summary = String(args.summary ?? "").trim()
          if (summary.length === 0) {
            return {
              ok: false,
              error: {
                code: "missing-summary",
                message: "wf_propose_batch requires a 'summary' string.",
              },
            }
          }
          const rawOps = (args.ops as Array<unknown>) ?? []
          if (!Array.isArray(rawOps) || rawOps.length === 0) {
            return {
              ok: false,
              error: {
                code: "missing-ops",
                message: "wf_propose_batch requires a non-empty 'ops' array.",
              },
            }
          }
          const ops: ProposalOp[] = []
          for (let i = 0; i < rawOps.length; i++) {
            const coerced = coerceProposalOp(rawOps[i], i)
            if (typeof coerced === "string") {
              return {
                ok: false,
                error: { code: "invalid-op", message: coerced },
              }
            }
            ops.push(coerced)
          }
          const state = store.getState()
          const validationError = validateProposalOps(ops, {
            nodeIds: new Set(state.nodes.map((n) => n.id)),
            edgeIds: new Set(state.edges.map((e) => e.id)),
          })
          if (validationError) {
            return {
              ok: false,
              error: { code: "invalid-proposal", message: validationError },
            }
          }
          const proposalId = nextProposalId()
          const opCount = summarizeOps(ops)
          const payload: ProposalPayload = getWorkflowApi().stageProposal({
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
            summary: payload.summary,
            opCount,
            baseRevision: payload.baseRevision,
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
          return formatToolError(err) as ProposeBatchToolResult
        }
      },
    },
  ]
}
