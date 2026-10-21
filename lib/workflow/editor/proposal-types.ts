/**
 * Workflow proposal types — shared by the proposal Zustand store and the
 * editor store's `applyProposalOps` action.
 *
 * A "proposal" is a batch of graph mutations the AI has drafted but not
 * yet applied. The proposal card (rendered in chat) shows the user what
 * will change and exposes Apply / Discard. Apply runs every op through
 * the editor store in a SINGLE `set()` call so the entire batch collapses
 * into one zundo entry (one Ctrl+Z reverses the whole proposal).
 *
 * Op semantics:
 *   • `add_node`      — create a node. `nodeId` is the FINAL id assigned
 *                       by `wf_propose_batch` at propose time (not a
 *                       temp id) so the proposal card and downstream ops
 *                       can reference it.
 *   • `remove_node`   — delete a node (and incident edges) by id.
 *   • `connect_edge`  — connect source → target. `edgeId` is the final
 *                       id assigned at propose time. Source / target may
 *                       reference either existing nodes or sibling
 *                       `add_node` ops within the same proposal.
 *   • `disconnect_edge` — delete an edge by id.
 *   • `configure_node`  — patch one node's data (label, params, notes,
 *                       disabled, credentialRefs).
 *
 * IDs are real and globally unique — generation lives in
 * `wf_propose_batch`, not here. The editor store assumes the ids are
 * already final; it does NOT regenerate them.
 */

import type {
  ProposalOp,
  ProposalOpCount,
} from "@cognia/plugin-contract/lib/workflow/editor/proposal-types"
export type {
  ProposalOp,
  ProposalOpAddNode,
  ProposalOpConfigureNode,
  ProposalOpConnectEdge,
  ProposalOpCount,
  ProposalOpDisconnectEdge,
  ProposalOpRemoveNode,
} from "@cognia/plugin-contract/lib/workflow/editor/proposal-types"

export function summarizeOps(ops: ReadonlyArray<ProposalOp>): ProposalOpCount {
  const out: ProposalOpCount = { add: 0, remove: 0, connect: 0, disconnect: 0, configure: 0 }
  for (const op of ops) {
    switch (op.type) {
      case "add_node":
        out.add++
        break
      case "remove_node":
        out.remove++
        break
      case "connect_edge":
        out.connect++
        break
      case "disconnect_edge":
        out.disconnect++
        break
      case "configure_node":
        out.configure++
        break
    }
  }
  return out
}
