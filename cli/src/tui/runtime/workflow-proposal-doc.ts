/**
 * Pure markdown builder for a Workflow Copilot proposal — the CLI counterpart of
 * the desktop `WorkflowProposalCard`. The copilot agent stages a batch of graph
 * mutations via `wf_propose_batch`; this renders the human-readable summary the
 * Apply/Discard confirm overlay shows, plus a projected "after" topology so the
 * user can see the resulting shape before committing.
 *
 * No store access, no Dexie — a transform over the proposal ops and (optionally)
 * the current graph, so it's fully unit-testable and reused verbatim by the
 * copilot controller.
 */
import type { ProposalOp } from "@/lib/workflow/editor/proposal-types"
import { summarizeOps } from "@/lib/workflow/editor/proposal-types"
import { buildDagAscii, type DagNodeLike } from "./workflow-dag"

/** Edge shape carrying the id needed to project `disconnect_edge`. */
export interface ProjectEdge {
  id: string
  source: string
  target: string
}

export interface ProposalDocInput {
  summary: string
  ops: ReadonlyArray<ProposalOp>
  /** Current graph nodes — when provided, the doc appends an "after" topology. */
  nodes?: ReadonlyArray<DagNodeLike>
  /** Current graph edges — paired with `nodes` for the projection. */
  edges?: ReadonlyArray<ProjectEdge>
}

/**
 * Apply the proposal ops to a shallow copy of the graph purely for DISPLAY.
 * Unlike the editor store's `applyProposalOps`, this skips validation and
 * re-id'ing — it only needs to produce the node/edge sets the DAG renderer
 * consumes. Unknown references are tolerated (the renderer drops danglers).
 */
export function projectOps(
  nodes: ReadonlyArray<DagNodeLike>,
  edges: ReadonlyArray<ProjectEdge>,
  ops: ReadonlyArray<ProposalOp>
): { nodes: DagNodeLike[]; edges: ProjectEdge[] } {
  const nodeById = new Map<string, DagNodeLike>(nodes.map((n) => [n.id, { ...n }]))
  const edgeById = new Map<string, ProjectEdge>(edges.map((e) => [e.id, { ...e }]))

  for (const op of ops) {
    switch (op.type) {
      case "add_node": {
        const label = typeof op.data?.label === "string" ? op.data.label : undefined
        nodeById.set(op.nodeId, {
          id: op.nodeId,
          type: op.kind,
          ...(label ? { data: { label } } : {}),
        })
        break
      }
      case "remove_node": {
        nodeById.delete(op.nodeId)
        for (const [eid, e] of edgeById) {
          if (e.source === op.nodeId || e.target === op.nodeId) edgeById.delete(eid)
        }
        break
      }
      case "connect_edge":
        edgeById.set(op.edgeId, { id: op.edgeId, source: op.source, target: op.target })
        break
      case "disconnect_edge":
        edgeById.delete(op.edgeId)
        break
      case "configure_node": {
        const existing = nodeById.get(op.nodeId)
        const label = typeof op.patch?.label === "string" ? op.patch.label : undefined
        if (existing && label) existing.data = { ...existing.data, label }
        break
      }
    }
  }
  return { nodes: [...nodeById.values()], edges: [...edgeById.values()] }
}

function opLine(op: ProposalOp): string {
  switch (op.type) {
    case "add_node": {
      const label = typeof op.data?.label === "string" ? op.data.label : op.kind
      return `+ Add node **${label}** \`${op.kind}\``
    }
    case "remove_node":
      return `− Remove node \`${op.nodeId}\``
    case "connect_edge":
      return `→ Connect \`${op.source}\` → \`${op.target}\``
    case "disconnect_edge":
      return `✂ Disconnect edge \`${op.edgeId}\``
    case "configure_node":
      return `⚙ Configure node \`${op.nodeId}\``
  }
}

/** Build the proposal review document (markdown) shown in the confirm overlay. */
export function buildProposalDoc(input: ProposalDocInput): string {
  const counts = summarizeOps(input.ops)
  const parts: string[] = ["# Workflow proposal", ""]
  if (input.summary.trim()) parts.push(input.summary.trim(), "")

  const tally: string[] = []
  if (counts.add) tally.push(`${counts.add} add`)
  if (counts.remove) tally.push(`${counts.remove} remove`)
  if (counts.connect) tally.push(`${counts.connect} connect`)
  if (counts.disconnect) tally.push(`${counts.disconnect} disconnect`)
  if (counts.configure) tally.push(`${counts.configure} configure`)
  parts.push(`**Changes:** ${tally.length ? tally.join(" · ") : "none"}`, "")

  for (const op of input.ops) parts.push(opLine(op))

  if (input.nodes) {
    const projected = projectOps(input.nodes, input.edges ?? [], input.ops)
    parts.push("", buildDagAscii(projected.nodes, projected.edges, { title: "After applying" }))
  }

  parts.push("", "_Apply to commit these changes to the workflow, or Discard to keep editing._")
  return parts.join("\n")
}
