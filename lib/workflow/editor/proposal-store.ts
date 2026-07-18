/**
 * Workflow proposal store — Zustand store holding the staged AI batch
 * proposal per workflow.
 *
 * Lifecycle:
 *   1. Agent calls `wf_propose_batch({ workflowId, summary, ops })`. The
 *      tool resolves all node/edge ids to final values, then calls
 *      `openProposal(workflowId, payload)`.
 *   2. The custom message-part renderer subscribes to this store keyed by
 *      `workflowId` and renders the diff card with Apply / Discard.
 *   3. Apply → caller invokes `editor.applyProposalOps(payload.ops)` and
 *      then `markApplied(workflowId)`. The proposal is moved into the
 *      `applied` slot so the card can show a "Applied" badge until the
 *      user opens a new proposal.
 *   4. Discard → caller invokes `discardProposal(workflowId)` which wipes
 *      the open proposal entirely.
 *
 * Invariants:
 *   • At most ONE open proposal per workflow at a time. `openProposal`
 *     replaces any prior open proposal for the same workflowId (the
 *     stale card gets re-rendered as "Discarded" via its proposalId
 *     subscription).
 *   • A workflow can have an open proposal AND a record of the
 *     most-recently-applied proposal in parallel (apply does NOT clear
 *     `applied`).
 *   • The store is a global singleton — there's at most one proposal
 *     card per workflow regardless of how many editor instances are
 *     mounted (rare in practice).
 */

import { create } from "zustand"
import type { ProposalOp, ProposalOpCount } from "./proposal-types"
import { summarizeOps } from "./proposal-types"
import { appendProposalHistory } from "./proposal-history"

function affectedNodeIdsFromOps(ops: ReadonlyArray<ProposalOp>): string[] {
  const ids = new Set<string>()
  for (const op of ops) {
    switch (op.type) {
      case "add_node":
      case "remove_node":
      case "configure_node":
        ids.add(op.nodeId)
        break
      case "connect_edge":
        ids.add(op.source)
        ids.add(op.target)
        break
    }
  }
  return [...ids]
}

function persistHistory(payload: ProposalPayload, status: "applied" | "discarded"): void {
  // Fire-and-forget — never block an Apply / Discard transition on a
  // Dexie hiccup. The Changelog tab tolerates missing rows gracefully.
  void appendProposalHistory({
    workflowId: payload.workflowId,
    proposalId: payload.proposalId,
    status,
    summary: payload.summary,
    opsCount: payload.ops.length,
    affectedNodeIds: affectedNodeIdsFromOps(payload.ops),
    createdAt: Date.now(),
  }).catch((err) => {
    console.warn("proposal-store: failed to persist history", err)
  })
}

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

export type ProposalStatus = "open" | "applied" | "discarded"

interface ProposalEntry {
  open?: ProposalPayload
  /**
   * Most-recently-applied proposal for the workflow. Kept after apply so
   * the proposal card (still mounted in the chat stream) can show
   * "Applied" instead of vanishing. Replaced on the next openProposal
   * for the same workflow.
   */
  lastApplied?: ProposalPayload
  /**
   * Most-recently-discarded proposal. Kept so the card can switch its
   * label to "Discarded" rather than disappearing. Replaced on the next
   * discardProposal or openProposal for the same workflow.
   */
  lastDiscarded?: ProposalPayload
}

interface ProposalStoreState {
  /** Keyed by workflowId. */
  entries: Record<string, ProposalEntry>
  openProposal: (
    workflowId: string,
    payload: Omit<ProposalPayload, "opCount" | "createdAt" | "baseRevision"> & {
      opCount?: ProposalOpCount
      createdAt?: number
      baseRevision?: string
    }
  ) => ProposalPayload
  /** Move the current open proposal to `lastApplied`. No-op if no open. */
  markApplied: (workflowId: string) => void
  /** Move the current open proposal to `lastDiscarded`. No-op if no open. */
  discardProposal: (workflowId: string) => void
  /** Re-anchor an open proposal after the user explicitly accepts the latest graph as its base. */
  rebaseProposal: (workflowId: string, baseRevision: string) => void
  /** Wipe every record (open / applied / discarded) for the workflow. */
  clearProposalsFor: (workflowId: string) => void
  /** Look up the status of a specific proposal id (across all workflows). */
  statusOf: (proposalId: string) => ProposalStatus | undefined
  /** Look up the payload by proposal id. */
  getProposal: (proposalId: string) => ProposalPayload | undefined
}

export const useProposalStore = create<ProposalStoreState>((set, get) => ({
  entries: {},

  openProposal: (workflowId, payload) => {
    const opCount = payload.opCount ?? summarizeOps(payload.ops)
    const createdAt = payload.createdAt ?? Date.now()
    const full: ProposalPayload = {
      proposalId: payload.proposalId,
      workflowId,
      summary: payload.summary,
      ops: payload.ops,
      baseRevision: payload.baseRevision ?? "legacy",
      opCount,
      createdAt,
    }
    let replacedOpen: ProposalPayload | undefined
    set((s) => {
      const prior = s.entries[workflowId]
      // Replacing the open proposal: the prior open becomes a discarded record.
      const next: ProposalEntry = {
        ...(prior ?? {}),
        open: full,
      }
      if (prior?.open) {
        next.lastDiscarded = prior.open
        replacedOpen = prior.open
      }
      return { entries: { ...s.entries, [workflowId]: next } }
    })
    // Persist the implicit discard so the changelog reflects every
    // terminal state, including silent replacements.
    if (replacedOpen) persistHistory(replacedOpen, "discarded")
    return full
  },

  markApplied: (workflowId) => {
    let applied: ProposalPayload | undefined
    set((s) => {
      const prior = s.entries[workflowId]
      if (!prior?.open) return s
      const next: ProposalEntry = {
        ...prior,
        open: undefined,
        lastApplied: prior.open,
      }
      applied = prior.open
      return { entries: { ...s.entries, [workflowId]: next } }
    })
    if (applied) persistHistory(applied, "applied")
  },

  discardProposal: (workflowId) => {
    let discarded: ProposalPayload | undefined
    set((s) => {
      const prior = s.entries[workflowId]
      if (!prior?.open) return s
      const next: ProposalEntry = {
        ...prior,
        open: undefined,
        lastDiscarded: prior.open,
      }
      discarded = prior.open
      return { entries: { ...s.entries, [workflowId]: next } }
    })
    if (discarded) persistHistory(discarded, "discarded")
  },

  rebaseProposal: (workflowId, baseRevision) => {
    set((state) => {
      const prior = state.entries[workflowId]
      if (!prior?.open) return state
      return {
        entries: {
          ...state.entries,
          [workflowId]: { ...prior, open: { ...prior.open, baseRevision } },
        },
      }
    })
  },

  clearProposalsFor: (workflowId) => {
    set((s) => {
      if (!s.entries[workflowId]) return s
      const next = { ...s.entries }
      delete next[workflowId]
      return { entries: next }
    })
  },

  statusOf: (proposalId) => {
    const entries = get().entries
    for (const entry of Object.values(entries)) {
      if (entry.open?.proposalId === proposalId) return "open"
      if (entry.lastApplied?.proposalId === proposalId) return "applied"
      if (entry.lastDiscarded?.proposalId === proposalId) return "discarded"
    }
    return undefined
  },

  getProposal: (proposalId) => {
    const entries = get().entries
    for (const entry of Object.values(entries)) {
      if (entry.open?.proposalId === proposalId) return entry.open
      if (entry.lastApplied?.proposalId === proposalId) return entry.lastApplied
      if (entry.lastDiscarded?.proposalId === proposalId) return entry.lastDiscarded
    }
    return undefined
  },
}))

/**
 * Test-only helper to reset the singleton store between cases. Not part
 * of the public API.
 */
export function __resetProposalStoreForTesting(): void {
  useProposalStore.setState({ entries: {} })
}
