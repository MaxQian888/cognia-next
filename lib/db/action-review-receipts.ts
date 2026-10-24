/**
 * Durable receipt log for the unified action review
 * (`packages/agent-config-types/src/action-review.ts`; policy in ADR-0239).
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
import {
  recordActionReviewEffectGovernance,
  recordActionReviewGovernance,
} from "@/lib/governance/producers/action-review"

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
 * What an outbound authorization key records (ADR-0239).
 *
 * - `deny`: a person refused these targets; the fence holds them refused for
 *   the rest of the instruction epoch, across tools and child runs.
 * - `grant`: a person allowed these targets for the rest of the instruction
 *   epoch ("allow for this request").
 */
export type ActionReviewAuthKeyKind = "deny" | "grant"

/**
 * The key one authorization stores and one lookup asks for.
 *
 * Root session and epoch are URI-encoded so a `|` inside either (an IM message
 * id can contain anything) can never make one epoch's prefix match another's.
 * The fingerprint is fixed-length hex and needs no escaping.
 */
export function actionReviewAuthKey(
  kind: ActionReviewAuthKeyKind,
  rootSessionId: string,
  instructionEpoch: string,
  fingerprint: string
): string {
  return `${actionReviewAuthKeyPrefix(kind, rootSessionId, instructionEpoch)}${fingerprint}`
}

/** Every key of one kind in one root session's epoch starts with this. */
export function actionReviewAuthKeyPrefix(
  kind: ActionReviewAuthKeyKind,
  rootSessionId: string,
  instructionEpoch: string
): string {
  return `${kind}|${encodeURIComponent(rootSessionId)}|${encodeURIComponent(instructionEpoch)}|`
}

/**
 * The authorization keys a receipt contributes (ADR-0239).
 *
 * Only an outbound review that knows its root session and epoch contributes.
 * A refusal fences only when a person made it: a timeout, an expiry, a system
 * denial (session closed, run aborted) and a policy deny are not a person
 * saying no, and the next attempt asks again. A grant contributes only at
 * `instruction` scope; `once` covers the single action it answered and
 * `policy` lives on the configured list, not here.
 */
function deriveAuthKeys(receipt: ActionReviewReceipt): string[] {
  const { request, decision } = receipt
  const targets = request.subject.targets
  const root = request.origin.rootSessionId
  const epoch = request.origin.instructionEpoch
  if (!targets?.length || !root || !epoch) return []
  const kind: ActionReviewAuthKeyKind | null =
    decision.outcome === "deny" && decision.authority === "human"
      ? "deny"
      : decision.grant?.scope === "instruction" &&
          (decision.outcome === "allow" || decision.outcome === "allow_always")
        ? "grant"
        : null
  if (!kind) return []
  return [...new Set(targets.map((t) => actionReviewAuthKey(kind, root, epoch, t.fingerprint)))]
}

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
  /**
   * multiEntry index — the fence and instruction grants (ADR-0239), one
   * {@link actionReviewAuthKey} per target. Empty for every other receipt,
   * and absent on rows written before schema v249.
   */
  authKeys: string[]
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
    authKeys: deriveAuthKeys(receipt),
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
      // A row that carries a fence or a grant is skipped: trimming it would
      // lift a person's refusal because unrelated reviews piled up. Those rows
      // still leave at their own expiry, and the cap may overshoot by them.
      const oldest = await db.actionReviewReceipts
        .orderBy("decidedAt")
        .filter((r) => !r.authKeys?.length)
        .limit(overflow)
        .primaryKeys()
      if (oldest.length > 0) {
        await db.actionReviewReceipts.bulkDelete(oldest as string[])
      }
    }
  })
  await recordActionReviewGovernance(receipt).catch(() => undefined)
  if (receipt.effect) {
    await recordActionReviewEffectGovernance(receipt.id, receipt.effect).catch(() => undefined)
  }
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
  const updated = await db.actionReviewReceipts.update(requestId, { effect })
  if (updated > 0) {
    await recordActionReviewEffectGovernance(requestId, effect).catch(() => undefined)
  }
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
 * True when an unexpired receipt carries `key` (ADR-0239). Answers "is this
 * target fenced in this epoch?" and "did a person allow it for this request?".
 */
export async function hasActionReviewAuthKey(
  key: string,
  now: number = Date.now()
): Promise<boolean> {
  const row = await getDb()
    .actionReviewReceipts.where("authKeys")
    .equals(key)
    .filter((r) => r.expiresAt > now)
    .first()
  return row !== undefined
}

/**
 * Every unexpired authorization key that starts with `prefix`, deduplicated:
 * the fence or the instruction grants of one root session's epoch, as built
 * by {@link actionReviewAuthKeyPrefix}.
 */
export async function listActionReviewAuthKeys(
  prefix: string,
  now: number = Date.now()
): Promise<string[]> {
  const rows = await getDb()
    .actionReviewReceipts.where("authKeys")
    .startsWith(prefix)
    .filter((r) => r.expiresAt > now)
    .toArray()
  const keys = new Set<string>()
  for (const row of rows) {
    for (const key of row.authKeys) if (key.startsWith(prefix)) keys.add(key)
  }
  return [...keys]
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

/**
 * Clear the log. Backs the Settings → Security "Clear" affordance.
 *
 * This also lifts every fence and instruction grant (ADR-0239), because they
 * are derived from these rows. A person clearing their own audit log is a
 * deliberate act; nothing calls this on its own.
 */
export async function clearActionReviewReceipts(): Promise<void> {
  await getDb().actionReviewReceipts.clear()
}
