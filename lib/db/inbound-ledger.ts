/**
 * Dedup ledger for inbound platform messages (schema v18; v38 added the
 * `namespace` field so the same machinery serves connector callbacks too).
 *
 * `recordInbound(adapterId, platformMessageId, namespace?, conversationKey?)`
 * stores a row keyed by the compound index
 * `[adapterId+namespace+platformMessageId]` and returns `true` if it is newly
 * recorded, `false` if it is a duplicate. `namespace` defaults to `"inbound"`
 * so every existing caller keeps its pre-v38 semantics. Callers handling
 * connector callbacks pass `"callback"`.
 *
 * `conversationKey` scopes the dedup key per conversation: several platforms
 * (Telegram `message_id`, Slack `ts`) only guarantee message-id uniqueness per
 * CHAT, so deduping on the bare id permanently dropped legitimate messages
 * whose ids collided across chats. The key is composed into the stored
 * `platformMessageId` string (`${conversationKey}#${messageId}`) so no Dexie
 * schema change is needed — the existing compound index keeps working.
 * Pre-existing unscoped rows simply age out of the capped window; the only
 * cost is that a redelivery straddling the upgrade dedups against a key the
 * old row does not carry (a one-time, bounded double-delivery risk).
 *
 * The table is capped at 10,000 newest rows by `pruneOldest`; the cap is
 * applied on demand (not per-write) so callers can batch-prune.
 */

import type { InboundLedgerNamespace, InboundLedgerRow } from "./connector-types"
import { getDb } from "./schema"

const DEFAULT_CAP = 10_000

/**
 * Compose the conversation-scoped dedup key stored in the row's
 * `platformMessageId` field. `#` cannot appear in a conversationKey
 * (they are `:`-joined tuples), so the composition is unambiguous.
 */
function composeDedupId(platformMessageId: string, conversationKey?: string): string {
  return conversationKey ? `${conversationKey}#${platformMessageId}` : platformMessageId
}

/**
 * Read-only duplicate probe: `true` when the (adapterId, namespace,
 * platformMessageId[, conversationKey]) tuple is already in the ledger.
 * Used by the callback pipeline, which must check up front but only COMMIT
 * the record on a terminal outcome (so a transient failure stays retryable).
 */
export async function isInboundRecorded(
  adapterId: string,
  platformMessageId: string,
  namespace: InboundLedgerNamespace = "inbound",
  conversationKey?: string
): Promise<boolean> {
  const existing = await getDb()
    .inboundLedger.where("[adapterId+namespace+platformMessageId]")
    .equals([adapterId, namespace, composeDedupId(platformMessageId, conversationKey)])
    .first()
  return existing !== undefined
}

/**
 * Record a sliding-window-deduped event.
 *
 * Returns `true` if the (adapterId, namespace, platformMessageId
 * [, conversationKey]) tuple was newly recorded, `false` if it is a
 * redelivery/duplicate.
 *
 * The check-then-add is made race-safe by the primary-key constraint: two
 * concurrent deliveries can both pass the read, but the second `.add` throws
 * `ConstraintError`, which is mapped to the ordinary "duplicate" result
 * instead of surfacing as a pipeline failure.
 *
 * @param adapterId         the adapter instance the event belongs to.
 * @param platformMessageId the platform-native identifier we dedupe on —
 *                          message id for inbound messages, trigger id
 *                          for connector callbacks, etc.
 * @param namespace         sliding-window namespace; defaults to
 *                          `"inbound"`.
 * @param conversationKey   optional per-conversation scope — REQUIRED for
 *                          inbound messages on platforms whose message ids
 *                          are only unique per chat (Telegram, Slack).
 *                          Callback trigger ids are already globally unique
 *                          per adapter, so callback callers omit it.
 */
export async function recordInbound(
  adapterId: string,
  platformMessageId: string,
  namespace: InboundLedgerNamespace = "inbound",
  conversationKey?: string
): Promise<boolean> {
  const db = getDb()
  const dedupId = composeDedupId(platformMessageId, conversationKey)
  // O(1) duplicate check via the v38 compound index (fast common path).
  const existing = await db.inboundLedger
    .where("[adapterId+namespace+platformMessageId]")
    .equals([adapterId, namespace, dedupId])
    .first()
  if (existing) return false

  const row: InboundLedgerRow = {
    // Embed namespace in the primary key so two namespaces can store the
    // same platformMessageId without colliding. Pre-v38 rows keep their
    // legacy `${adapterId}:${platformMessageId}` ids; the compound index
    // makes them queryable too, so we never need to rename them.
    id: `${adapterId}:${namespace}:${dedupId}`,
    adapterId,
    namespace,
    platformMessageId: dedupId,
    receivedAt: Date.now(),
  }
  try {
    await db.inboundLedger.add(row)
  } catch (err) {
    // Lost the check-then-add race against a concurrent delivery of the
    // same event — the row already exists, so this IS a duplicate.
    if ((err as { name?: string } | null)?.name === "ConstraintError") return false
    throw err
  }
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
