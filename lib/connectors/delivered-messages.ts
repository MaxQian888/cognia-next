/**
 * Delivered-message ledger — "did WE send message X into conversation Y?"
 *
 * Backs the exact `reply-to-bot` trigger rule (`policy-eval.ts`). Every
 * successful platform delivery that yields a real `platformMessageId` is
 * recorded here; when an inbound event arrives with a `replyTo` whose parent
 * sender is unknown (the wire shape carried no author — OneBot reply
 * segments, Matrix after a restart, …), the bus asks {@link wasDeliveredByUs}
 * and, on a hit, stamps `replyTo.parentSenderId = event.selfId` before the
 * policy evaluator runs.
 *
 * Storage reuses `inboundLedger` under the dedicated `"outbound"` namespace
 * (compound index `[adapterId+namespace+platformMessageId]`, Dexie v38) so no
 * new table is needed. Rows are scoped by `conversationKey` because several
 * platforms (Telegram, OneBot) only guarantee message-id uniqueness per chat.
 * The ledger's global 10k-row cap (`pruneOldest`) applies — old bot messages
 * eventually age out, which only relaxes the rule back to "not a reply to
 * the bot" (never a false positive).
 */

import { isInboundRecorded, recordInbound } from "@/lib/db/inbound-ledger"

export const DELIVERED_LEDGER_NAMESPACE = "outbound" as const

/**
 * Record a platform message id we successfully delivered. Idempotent — a
 * second call for the same tuple is a no-op. Never throws: a ledger failure
 * must not fail the delivery that already happened.
 */
export async function recordDeliveredMessage(
  adapterId: string,
  conversationKey: string,
  platformMessageId: string
): Promise<void> {
  if (!adapterId || !conversationKey || !platformMessageId) return
  try {
    await recordInbound(adapterId, platformMessageId, DELIVERED_LEDGER_NAMESPACE, conversationKey)
  } catch {
    /* best-effort — the delivery already succeeded */
  }
}

/**
 * `true` when `platformMessageId` was delivered by us into `conversationKey`.
 * Never throws (a Dexie failure reads as "unknown", i.e. `false`).
 */
export async function wasDeliveredByUs(
  adapterId: string,
  conversationKey: string,
  platformMessageId: string
): Promise<boolean> {
  if (!adapterId || !conversationKey || !platformMessageId) return false
  try {
    return await isInboundRecorded(
      adapterId,
      platformMessageId,
      DELIVERED_LEDGER_NAMESPACE,
      conversationKey
    )
  } catch {
    return false
  }
}
