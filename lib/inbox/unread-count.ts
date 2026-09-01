/**
 * Unread counts for the mobile shell's two badges.
 *
 * Both used to count `inboundLedger` rows newer than `lastInboxViewedAt`. That
 * table is a host-only dedupe ledger, it is not in the companion sync protocol,
 * and it never will be: it is unbounded, pruned by count, and a dedupe record
 * is the wrong artifact to mirror in order to draw a number. So the Chat tab
 * badge and the Inbox dot were both permanently 0 on every paired device.
 *
 * The honest source is `sessionState`, which is what the desktop's own unread
 * badges read (`hooks/shell/use-guild-unread.ts`) and which now syncs. Sharing
 * the table is the point: two shells that agree by construction beat two
 * implementations of "unread" that drift.
 *
 * Deliberately NOT derived from `messages.createdAt > lastReadAt`. That counts
 * the user's own turns, assistant replies and system messages, and it counts
 * them in conversations that have nothing to do with the Inbox.
 */

import { isSessionExposed } from "@/lib/chat/session-exposure"
import { getDb } from "@/lib/db/schema"
import { listSessionStates } from "@/lib/db/session-state"
import type { ChatSession } from "@cognia/agent-config-types"

/**
 * The session fields the counts actually read. Mirrors `UnreadSession` in
 * `use-guild-unread.ts` and adds the two IM binding markers, which are what
 * separates an Inbox conversation from an ordinary one.
 */
export type UnreadCountSession = Pick<
  ChatSession,
  | "id"
  | "kind"
  | "archivedAt"
  | "visibility"
  | "platformBinding"
  | "platformConversationKey"
  | "integrationBinding"
>

export interface MobileUnreadCounts {
  /** Unread conversations the Chat tab would show. */
  chat: number
  /** The subset bound to an IM platform or a service integration. */
  inbox: number
}

export const EMPTY_UNREAD_COUNTS: MobileUnreadCounts = Object.freeze({ chat: 0, inbox: 0 })

/** Whether the Inbox, rather than only the chat list, files this conversation. */
function isInboxConversation(session: UnreadCountSession): boolean {
  return (
    session.platformBinding != null ||
    session.platformConversationKey != null ||
    session.integrationBinding != null
  )
}

/**
 * Pure aggregation: one unread conversation counts once.
 *
 * Same exclusions as the desktop guild badge, for the same reason. An archived
 * conversation and a transcript the main list never shows must not contribute
 * to a badge that promises something tappable.
 */
export function countMobileUnread(
  sessions: ReadonlyArray<UnreadCountSession | undefined>,
  unreadBySession: ReadonlyMap<string, number>
): MobileUnreadCounts {
  let chat = 0
  let inbox = 0
  for (const session of sessions) {
    if (!session) continue
    if (!unreadBySession.has(session.id)) continue
    if (session.archivedAt != null) continue
    if (!isSessionExposed(session, "main-list")) continue
    chat += 1
    if (isInboxConversation(session)) inbox += 1
  }
  return { chat, inbox }
}

/**
 * Resolve both counts from Dexie.
 *
 * Reads the unread pointers first and then resolves only the sessions they
 * name, so a long history costs nothing beyond the handful of rows that
 * actually have unread. A pointer whose session is gone resolves to
 * `undefined` and is skipped, which is why `sessionState` needs no tombstones
 * of its own.
 */
export async function loadMobileUnread(): Promise<MobileUnreadCounts> {
  const states = await listSessionStates()
  const unreadBySession = new Map<string, number>()
  for (const state of states) {
    if (state.unreadCount > 0) unreadBySession.set(state.sessionId, state.unreadCount)
  }
  if (unreadBySession.size === 0) return EMPTY_UNREAD_COUNTS
  const sessions = await getDb().sessions.bulkGet([...unreadBySession.keys()])
  return countMobileUnread(sessions as (UnreadCountSession | undefined)[], unreadBySession)
}
