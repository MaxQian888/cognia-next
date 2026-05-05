/**
 * Dedup ledger for inbound platform messages (schema v18).
 *
 * `recordInbound` stores a row keyed by `[adapterId+platformMessageId]` and
 * returns `true` if the message is newly recorded, `false` if it is a
 * duplicate. The table is capped at 10,000 newest rows by `pruneOldest`; the
 * cap is applied on demand (not per-write) so callers can batch-prune.
 */

import type { InboundLedgerRow } from "./connector-types"
import { getDb } from "./schema"

const DEFAULT_CAP = 10_000

/**
 * Record an inbound message. Returns `true` if newly recorded, `false` if
 * already present (duplicate / redelivery).
 */
export async function recordInbound(
  adapterId: string,
  platformMessageId: string
): Promise<boolean> {
  const db = getDb()
  // O(1) duplicate check via [adapterId+platformMessageId] compound index.
  const existing = await db.inboundLedger
    .where("[adapterId+platformMessageId]")
    .equals([adapterId, platformMessageId])
    .first()
  if (existing) return false

  const row: InboundLedgerRow = {
    id: `${adapterId}:${platformMessageId}`,
    adapterId,
    platformMessageId,
    receivedAt: Date.now(),
  }
  await db.inboundLedger.add(row)
  return true
}

/**
 * Keep `cap` newest rows (by `receivedAt`), delete the rest.
 * Defaults to 10,000.
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
