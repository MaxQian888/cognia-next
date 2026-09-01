// Per-session unread tracking. Distinct from the immutable session metadata
// so message-arrival churn doesn't trigger a `sessions` table write on every
// streaming token. Used by the channel list to render unread dots/counts
// like Discord.

import { getDb } from "./schema"

/**
 * Per-session unread tracking. Only sessions the user has actually opened
 * have a row here; everything else is treated as unread = 0.
 *
 * Co-located with this CRUD module; `schema.ts` imports + re-exports it, so
 * existing `@/lib/db/schema` import sites keep working. See `CONVENTIONS.md`.
 */
export interface SessionStateRow {
  sessionId: string
  lastReadAt: number
  unreadCount: number
  /**
   * Sync watermark. Non-indexed, so it needs no Dexie version bump.
   *
   * `lastReadAt` cannot serve as the cursor: `bumpUnread` deliberately
   * preserves it, so the one event a paired device most needs to hear about,
   * a conversation going unread, would never advance the watermark and would
   * never cross the wire. Both writers stamp this instead. Legacy rows have no
   * `updatedAt`, so the reader falls back to `lastReadAt` and they cross once.
   */
  updatedAt?: number
}

export async function getSessionState(sessionId: string): Promise<SessionStateRow | undefined> {
  return getDb().sessionState.get(sessionId)
}

export async function listSessionStates(): Promise<SessionStateRow[]> {
  return getDb().sessionState.toArray()
}

/** Mark a session as read — clears unread count and bumps the read pointer. */
export async function markSessionRead(sessionId: string): Promise<void> {
  const now = Date.now()
  await getDb().sessionState.put({
    sessionId,
    lastReadAt: now,
    unreadCount: 0,
    updatedAt: now,
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
      updatedAt: Date.now(),
    })
  })
}
