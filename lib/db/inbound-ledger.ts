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
 * `pruneOldest` keeps the 10,000 newest windowed rows and, apart from them,
 * the 50,000 newest delivered-message rows (`"outbound"`), and never prunes
 * `"landed-chat"` rows; the caps are applied on demand (not per-write) so
 * callers can batch-prune.
 */

import type { InboundLedgerNamespace, InboundLedgerRow } from "./connector-types"
import { getDb } from "./schema"

const DEFAULT_CAP = 10_000
/** Delivered-message rows (`"outbound"`) are capped apart; see {@link pruneOldest}. */
const DEFAULT_DELIVERED_CAP = 50_000
const DELIVERED_NAMESPACE: InboundLedgerNamespace = "outbound"
const LANDED_NAMESPACE: InboundLedgerNamespace = "landed-chat"

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
 * The ids recorded in `namespace` for `conversationKey` (rows written with
 * that key), in id order. A range over the compound index, so it reads only
 * that conversation's rows.
 */
export async function listRecordedIds(
  adapterId: string,
  namespace: InboundLedgerNamespace,
  conversationKey: string
): Promise<string[]> {
  if (!conversationKey) return []
  const prefix = composeDedupId("", conversationKey)
  const rows = await getDb()
    .inboundLedger.where("[adapterId+namespace+platformMessageId]")
    .between([adapterId, namespace, prefix], [adapterId, namespace, `${prefix}\uffff`])
    .toArray()
  return rows.map((row) => row.platformMessageId.slice(prefix.length))
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
 * Keep the `cap` newest windowed rows (by `receivedAt`) and the
 * `deliveredCap` newest `"outbound"` rows, delete the rest.
 *
 * Windowed rows (inbound, callback, welcome) only dedupe redeliveries, so
 * 10,000 across those namespaces is plenty. Delivered rows are what the host
 * knows of the messages its bots sent (`delivered-messages.ts`): they let a
 * reply to the bot be recognised and let a plugin's reply to or edit of a
 * bot message be placed in its conversation (ADR-0239), so they are kept
 * apart and longer, and an inbound burst cannot push them out.
 */
export async function pruneOldest(
  cap = DEFAULT_CAP,
  deliveredCap = DEFAULT_DELIVERED_CAP
): Promise<void> {
  const db = getDb()
  const total = await db.inboundLedger.count()
  // Rows without a namespace (pre-v38) are not in the index: they count as windowed.
  const delivered = await db.inboundLedger.where("namespace").equals(DELIVERED_NAMESPACE).count()
  // One row per conversation and chat a delivery landed in: bounded by the
  // conversations, and needed for as long as they are.
  const landed = await db.inboundLedger.where("namespace").equals(LANDED_NAMESPACE).count()
  await dropOldest(
    total - delivered - landed - cap,
    (row) => row.namespace !== DELIVERED_NAMESPACE && row.namespace !== LANDED_NAMESPACE
  )
  await dropOldest(delivered - deliveredCap, (row) => row.namespace === DELIVERED_NAMESPACE)
}

/** Delete the `overflow` oldest rows `matches` accepts, walking from the oldest. */
async function dropOldest(
  overflow: number,
  matches: (row: InboundLedgerRow) => boolean
): Promise<void> {
  if (overflow <= 0) return
  const oldest = await getDb()
    .inboundLedger.orderBy("receivedAt")
    .filter(matches)
    .limit(overflow)
    .primaryKeys()
  if (oldest.length > 0) await getDb().inboundLedger.bulkDelete(oldest as string[])
}
