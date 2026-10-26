/**
 * The plugin contract's share of `lib/workflow/editor/proposal-store.ts`, which re-exports these.
 */
import type { ProposalOp, ProposalOpCount } from "./proposal-types"

export interface ProposalPayload {
  proposalId: string
  workflowId: string
  summary: string
  ops: ReadonlyArray<ProposalOp>
  /** Semantic editor revision captured when this proposal was created. */
  baseRevision: string
  opCount: ProposalOpCount
  /**
   * Wall-clock ms at create time. Used by the card to show "Proposed Xs
   * ago" + by tests to assert ordering.
   */
  createdAt: number
}
