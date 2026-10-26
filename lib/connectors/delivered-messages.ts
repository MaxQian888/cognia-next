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
 * The rows are also how a plugin's reply to or edit of a bot message is
 * placed in its conversation (ADR-0239, `message-placement.ts`), so they have
 * their own 50k-row cap in `pruneOldest`, apart from the 10k window of
 * inbound rows. Old bot messages still age out eventually: that relaxes the
 * rule back to "not a reply to the bot" (never a false positive), and a
 * plugin's reply to one is then placed by the platform, if it can be.
 */

import { isInboundRecorded, listRecordedIds, recordInbound } from "@/lib/db/inbound-ledger"

export const DELIVERED_LEDGER_NAMESPACE = "outbound" as const
/**
 * The platform chats deliveries through a conversation landed in, when the
 * adapter reports one (`OutboundResult.platformChatId`). A conversation that
 * names a person (a Lark open id) learns its chat only this way; one row per
 * conversation and chat, never pruned.
 */
export const LANDED_CHAT_LEDGER_NAMESPACE = "landed-chat" as const

/**
 * Record a platform message id we successfully delivered. Idempotent — a
 * second call for the same tuple is a no-op. Never throws: a ledger failure
 * must not fail the delivery that already happened.
 */
export async function recordDeliveredMessage(
  adapterId: string,
  conversationKey: string,
  platformMessageId: string,
  platformChatId?: string
): Promise<void> {
  if (!adapterId || !conversationKey) return
  try {
    if (platformMessageId) {
      await recordInbound(adapterId, platformMessageId, DELIVERED_LEDGER_NAMESPACE, conversationKey)
    }
    if (platformChatId) {
      await recordInbound(adapterId, platformChatId, LANDED_CHAT_LEDGER_NAMESPACE, conversationKey)
    }
  } catch {
    /* best-effort — the delivery already succeeded */
  }
}

/**
 * The platform chats deliveries through `conversationKey` landed in. Never
 * throws (a Dexie failure reads as none known).
 */
export async function landedChatsOf(adapterId: string, conversationKey: string): Promise<string[]> {
  if (!adapterId || !conversationKey) return []
  try {
    return await listRecordedIds(adapterId, LANDED_CHAT_LEDGER_NAMESPACE, conversationKey)
  } catch {
    return []
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
