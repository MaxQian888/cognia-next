/**
 * Durable receipt log for the unified action review (ADR-0102).
 *
 * One row per reviewed action, across every decision point: chat tool
 * approvals, Agent Team plan and capability gates, workflow step gates,
 * connector HITL, and thread-handoff adjudication.
 *
 * This table exists because there was nowhere durable for an approval to land.
 * `stores/agent/approval-journal-store.ts` is localStorage, capped at 100
 * entries, and marks every unsettled row `interrupted` on reboot — a UI cache,
 * never an audit record. The ten pre-existing domain audit logs
 * (`mcpAuditLog`, `connectorAudit`, `automationAuditLog`, …) each record their
 * own side of the world and none of them record a tool approval at all. Those
 * stay exactly as they are; producers dual-write here.
 *
 * Shape mirrors `lib/automation/audit.ts`: a row that extends the wire type
 * with FLATTENED query columns, one writer (`toReceiptRow`) that derives them,
 * and an LRU cap enforced inside the same transaction as the write. `schema.ts`
 * imports and re-exports the row type, so `@/lib/db/schema` stays the stable
 * import surface (see `lib/db/CONVENTIONS.md`).
 */

import type {
  ActionReviewAuthority,
  ActionReviewChannel,
  ActionReviewEffect,
  ActionReviewOutcome,
  ActionReviewReceipt,
  ActionReviewSurfaceId,
  ActionReviewTier,
} from "@cognia/agent-config-types/action-review"

import { getDb } from "./schema"

const MS_PER_DAY = 86_400_000

/**
 * How long a receipt is kept. A fixed product decision, not an operator
 * setting — an audit window the audited party can shorten is not an audit
 * window. Stamped onto each row as `expiresAt` at write time.
 */
export const ACTION_REVIEW_RETENTION_DAYS = 90

/**
 * Hard row ceiling, enforced in the same transaction as the write.
 *
 * Retention is the primary bound; this is the backstop for a pathological
 * burst (a runaway loop approving thousands of calls inside the window) that
 * would otherwise grow the table unbounded before the daily sweep runs.
 */
export const ACTION_REVIEW_RECEIPT_CAP = 20_000

/**
 * Dexie row: the receipt plus flattened, indexed query columns.
 *
 * Dexie can index nested paths, but a receipt is queried on six independent
 * axes plus two compounds, and `*surfaceIds` needs a top-level array to be a
 * multiEntry index at all. Flattening keeps the index declaration readable and
 * matches `AutomationAuditLogRow extends AuditEntry`.
 *
 * These fields are DERIVED. `toReceiptRow` is the only thing that writes them;
 * treat `request`/`decision` as the source of truth and never patch a column
 * without re-deriving.
 */
export interface ActionReviewReceiptRow extends ActionReviewReceipt {
  decidedAt: number
  outcome: ActionReviewOutcome
  authority: ActionReviewAuthority
  tier: ActionReviewTier
  channel: ActionReviewChannel
  sessionId?: string
  runId?: string
  projectId?: string
  /** multiEntry index — "every credential-auth decision this quarter". */
  surfaceIds: ActionReviewSurfaceId[]
}

/**
 * Derive the persisted row from a receipt.
 *
 * `expiresAt` is taken from the receipt when the producer already computed it,
 * so a receipt minted under a different retention policy expires on its own
 * terms rather than being silently re-dated by whatever this build thinks the
 * window is.
 */
export function toReceiptRow(receipt: ActionReviewReceipt): ActionReviewReceiptRow {
  const { request, decision } = receipt
  return {
    ...receipt,
    expiresAt: receipt.expiresAt || decision.decidedAt + ACTION_REVIEW_RETENTION_DAYS * MS_PER_DAY,
    decidedAt: decision.decidedAt,
    outcome: decision.outcome,
    authority: decision.authority,
    tier: request.tier,
    channel: request.origin.channel,
    sessionId: request.origin.sessionId,
    runId: request.origin.runId,
    projectId: request.origin.projectId,
    surfaceIds: request.surfaces.map((s) => s.id),
  }
}

/**
 * Persist a receipt and enforce the row cap.
 *
 * Idempotent on `id`: re-recording the same review overwrites rather than
 * duplicating, which is what makes a retry after a failed write safe.
 */
export async function recordActionReviewReceipt(
  receipt: ActionReviewReceipt,
  /**
   * Row ceiling override. Defaults to {@link ACTION_REVIEW_RECEIPT_CAP};
   * exists so the cap behaviour is testable without materialising 20 000 rows
   * in fake-indexeddb, which takes longer than a Jest timeout.
   */
  cap: number = ACTION_REVIEW_RECEIPT_CAP
): Promise<void> {
  const row = toReceiptRow(receipt)
  const db = getDb()
  await db.transaction("rw", db.actionReviewReceipts, async () => {
    await db.actionReviewReceipts.put(row)
    const count = await db.actionReviewReceipts.count()
    if (count > cap) {
      const overflow = count - cap
      const oldest = await db.actionReviewReceipts
        .orderBy("decidedAt")
        .limit(overflow)
        .primaryKeys()
      if (oldest.length > 0) {
        await db.actionReviewReceipts.bulkDelete(oldest as string[])
      }
    }
  })
}

/**
 * Attach the observed effect to an already-recorded decision.
 *
 * Separate from the write because the decision and its effect happen at
 * different times: the review resolves, then the action runs (or doesn't). A
 * receipt with no effect means "we never learned what happened", which is
 * itself worth seeing in the log — so a missing row is a silent no-op rather
 * than an error that would break the host flow.
 */
export async function attachActionReviewEffect(
  requestId: string,
  effect: ActionReviewEffect
): Promise<void> {
  const db = getDb()
  await db.actionReviewReceipts.update(requestId, { effect })
}

export async function getActionReviewReceipt(
  id: string
): Promise<ActionReviewReceiptRow | undefined> {
  return getDb().actionReviewReceipts.get(id)
}

export interface ActionReviewReceiptFilter {
  channel?: ActionReviewChannel
  outcome?: ActionReviewOutcome
  authority?: ActionReviewAuthority
  tier?: ActionReviewTier
  surfaceId?: ActionReviewSurfaceId
  sessionId?: string
  runId?: string
  /** Only receipts decided at or after this timestamp. */
  since?: number
  limit?: number
}

/** Snapshot the log, newest-first, with optional filters. */
export async function listActionReviewReceipts(
  filter?: ActionReviewReceiptFilter
): Promise<ActionReviewReceiptRow[]> {
  const db = getDb()
  let coll = db.actionReviewReceipts.orderBy("decidedAt").reverse()

  if (filter?.since !== undefined) {
    const since = filter.since
    coll = coll.filter((r) => r.decidedAt >= since)
  }
  for (const [key, value] of [
    ["channel", filter?.channel],
    ["outcome", filter?.outcome],
    ["authority", filter?.authority],
    ["tier", filter?.tier],
    ["sessionId", filter?.sessionId],
    ["runId", filter?.runId],
  ] as const) {
    if (value === undefined) continue
    coll = coll.filter((r) => r[key] === value)
  }
  if (filter?.surfaceId !== undefined) {
    const surfaceId = filter.surfaceId
    coll = coll.filter((r) => r.surfaceIds.includes(surfaceId))
  }
  if (filter?.limit !== undefined && filter.limit > 0) {
    coll = coll.limit(filter.limit)
  }
  return coll.toArray()
}

/**
 * Delete every receipt past its own watermark. Returns the count removed.
 *
 * Indexes `expiresAt` rather than recomputing `now - retentionDays`, so
 * changing the retention constant never retroactively re-dates rows already on
 * disk — each expires on the terms it was written under.
 */
export async function pruneActionReviewReceipts(now: number = Date.now()): Promise<number> {
  const db = getDb()
  const expired = await db.actionReviewReceipts.where("expiresAt").below(now).primaryKeys()
  if (expired.length === 0) return 0
  await db.actionReviewReceipts.bulkDelete(expired as string[])
  return expired.length
}

/** Clear the log. Backs the Settings → Security "Clear" affordance. */
export async function clearActionReviewReceipts(): Promise<void> {
  await getDb().actionReviewReceipts.clear()
}
