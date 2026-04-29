// Per-session unread tracking. Distinct from the immutable session metadata
// so message-arrival churn doesn't trigger a `sessions` table write on every
// streaming token. Used by the channel list to render unread dots/counts
// like Discord.

import { getDb, type SessionStateRow } from "./schema"

export async function getSessionState(sessionId: string): Promise<SessionStateRow | undefined> {
  return getDb().sessionState.get(sessionId)
}

export async function listSessionStates(): Promise<SessionStateRow[]> {
  return getDb().sessionState.toArray()
}

/** Mark a session as read — clears unread count and bumps the read pointer. */
export async function markSessionRead(sessionId: string): Promise<void> {
  await getDb().sessionState.put({
    sessionId,
    lastReadAt: Date.now(),
    unreadCount: 0,
  })
}

/** Increment a session's unread counter by one. */
export async function bumpUnread(sessionId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.sessionState, async () => {
    const cur = await db.sessionState.get(sessionId)
    await db.sessionState.put({
      sessionId,
      lastReadAt: cur?.lastReadAt ?? 0,
      unreadCount: (cur?.unreadCount ?? 0) + 1,
    })
  })
}
