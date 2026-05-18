/**
 * Dedup ledger for inbound platform messages (schema v18; v38 added the
 * `namespace` field so the same machinery serves connector callbacks too).
 *
 * `recordInbound(adapterId, platformMessageId, namespace?)` stores a row
 * keyed by the compound index `[adapterId+namespace+platformMessageId]`
 * and returns `true` if it is newly recorded, `false` if it is a
 * duplicate. `namespace` defaults to `"inbound"` so every existing caller
 * keeps its pre-v38 semantics. Callers handling connector callbacks pass
 * `"callback"`.
 *
 * The table is capped at 10,000 newest rows by `pruneOldest`; the cap is
 * applied on demand (not per-write) so callers can batch-prune.
 */

import type { InboundLedgerNamespace, InboundLedgerRow } from "./connector-types"
import { getDb } from "./schema"

const DEFAULT_CAP = 10_000

/**
 * Record a sliding-window-deduped event.
 *
 * Returns `true` if the (adapterId, namespace, platformMessageId) triple
 * was newly recorded, `false` if it is a redelivery/duplicate.
 *
 * @param adapterId         the adapter instance the event belongs to.
 * @param platformMessageId the platform-native identifier we dedupe on —
 *                          message id for inbound messages, trigger id
 *                          for connector callbacks, etc.
 * @param namespace         sliding-window namespace; defaults to
 *                          `"inbound"`.
 */
export async function recordInbound(
  adapterId: string,
  platformMessageId: string,
  namespace: InboundLedgerNamespace = "inbound"
): Promise<boolean> {
  const db = getDb()
  // O(1) duplicate check via the v38 compound index.
  const existing = await db.inboundLedger
    .where("[adapterId+namespace+platformMessageId]")
    .equals([adapterId, namespace, platformMessageId])
    .first()
  if (existing) return false

  const row: InboundLedgerRow = {
    // Embed namespace in the primary key so two namespaces can store the
    // same platformMessageId without colliding. Pre-v38 rows keep their
    // legacy `${adapterId}:${platformMessageId}` ids; the compound index
    // makes them queryable too, so we never need to rename them.
    id: `${adapterId}:${namespace}:${platformMessageId}`,
    adapterId,
    namespace,
    platformMessageId,
    receivedAt: Date.now(),
  }
  await db.inboundLedger.add(row)
  return true
}

/**
 * Keep `cap` newest rows (by `receivedAt`), delete the rest.
 * Defaults to 10,000. Applied across all namespaces — the cap is global,
 * not per-namespace, matching the v18 semantics.
 */
export async function pruneOldest(cap = DEFAULT_CAP): Promise<void> {
  const db = getDb()
  const total = await db.inboundLedger.count()
  if (total <= cap) return
  const overflow = total - cap
  const oldest = await db.inboundLedger.orderBy("receivedAt").limit(overflow).primaryKeys()
  if (oldest.length > 0) {
    await db.inboundLedger.bulkDelete(oldest as string[])
  }
}
