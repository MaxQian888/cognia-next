/**
 * Workflow proposal history — persistent timeline of every
 * applied / discarded proposal so the right-sidebar Changelog tab can
 * surface "what did the AI just touch?".
 *
 * Mirrors the shape of `lib/db/backup-history.ts` (append + list +
 * prune) — keeping the storage layer thin and giving the Changelog UI
 * a familiar paginated read with newest-first ordering.
 *
 * Capped at 50 rows PER WORKFLOW. Older entries are pruned on every
 * write so the table never grows unbounded.
 */

import { getDb } from "@/lib/db/schema"

/** Persisted row shape. */
export interface WorkflowProposalHistoryRow {
  /** `${proposalId}:${status}` — proposalId can appear twice if a future
   *  flow re-opens a discarded proposal (currently impossible, but the
   *  composite key future-proofs the table). */
  id: string
  workflowId: string
  proposalId: string
  /** Terminal state — proposals are persisted only AFTER apply/discard. */
  status: "applied" | "discarded"
  /** Human-readable description from the original `wf_propose_batch`. */
  summary: string
  /** How many ops were in the batch. */
  opsCount: number
  /** Nodes that were directly touched — for "Open snapshot" jump. */
  affectedNodeIds: string[]
  /** Chat messageId that rendered the proposal card. Empty if not known. */
  messageId?: string
  /** Wall-clock when the terminal transition happened. */
  createdAt: number
}

/** Max rows retained per workflow. Older entries are pruned on append. */
export const PROPOSAL_HISTORY_LIMIT = 50

/**
 * Append a proposal-history row and prune older rows for the same
 * workflow when the per-workflow count exceeds the limit. Failures
 * are surfaced — callers (the proposal store transitions) wrap this
 * in `void appendProposalHistory(...).catch(...)` so a Dexie hiccup
 * never blocks an Apply/Discard transition.
 */
export async function appendProposalHistory(
  row: Omit<WorkflowProposalHistoryRow, "id"> & { id?: string }
): Promise<WorkflowProposalHistoryRow> {
  const id = row.id ?? `${row.proposalId}:${row.status}`
  const full: WorkflowProposalHistoryRow = { ...row, id }
  const table = getDb().workflowProposalHistory
  await table.put(full)
  await pruneOldProposalHistory(row.workflowId)
  return full
}

/** Newest-first list of history rows for one workflow. */
export async function listProposalHistory(
  workflowId: string,
  limit: number = PROPOSAL_HISTORY_LIMIT
): Promise<WorkflowProposalHistoryRow[]> {
  const rows = await getDb()
    .workflowProposalHistory.where("workflowId")
    .equals(workflowId)
    .toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows.slice(0, limit)
}

/**
 * Drop history rows above the per-workflow cap. Keeps the most recent
 * `PROPOSAL_HISTORY_LIMIT` entries; deletes the rest in one batch.
 */
export async function pruneOldProposalHistory(workflowId: string): Promise<number> {
  const rows = await getDb()
    .workflowProposalHistory.where("workflowId")
    .equals(workflowId)
    .toArray()
  if (rows.length <= PROPOSAL_HISTORY_LIMIT) return 0
  rows.sort((a, b) => b.createdAt - a.createdAt)
  const stale = rows.slice(PROPOSAL_HISTORY_LIMIT)
  await getDb().workflowProposalHistory.bulkDelete(stale.map((r) => r.id))
  return stale.length
}

/** Drop every row for one workflow — used by deleteWorkflow cleanup paths. */
export async function deleteProposalHistoryForWorkflow(workflowId: string): Promise<number> {
  const rows = await getDb()
    .workflowProposalHistory.where("workflowId")
    .equals(workflowId)
    .toArray()
  if (rows.length === 0) return 0
  await getDb().workflowProposalHistory.bulkDelete(rows.map((r) => r.id))
  return rows.length
}
