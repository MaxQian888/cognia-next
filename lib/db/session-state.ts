// Per-session unread tracking. Distinct from the immutable session metadata
// so message-arrival churn doesn't trigger a `sessions` table write on every
// streaming token. Used by the channel list to render unread dots/counts
// like Discord.

import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
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
  const database = getDb()
  const scope = getActiveRuntimeTargetContext()
  const scopeKey = JSON.stringify(scope)
  const scopeChanged = () =>
    getDb() !== database || JSON.stringify(getActiveRuntimeTargetContext()) !== scopeKey
  const { getRuntimeSnapshot } = await import("@/lib/runtime/runtime-snapshot-store")
  const { isRemoteHostActive } = await import("@/lib/tauri/transport-routing")
  const remote = isRemoteHostActive() || getRuntimeSnapshot().target?.kind === "companion"
  if (scopeChanged()) return
  const localHistory =
    remote &&
    (await import("@/lib/sync/session-history")).getSessionHistoryMode(sessionId) === "local"
  if (scopeChanged()) return
  if (remote && !localHistory) {
    const { enqueue } = await import("./mobile-outbound-queue")
    if (scopeChanged()) return
    const db = database
    await db.transaction("rw", db.sessions, db.sessionState, db.mobileOutboundQueue, async () => {
      if ((await db.sessions.where("id").equals(sessionId).count()) === 0) return
      const current = await db.sessionState.get(sessionId)
      const readThrough = current?.updatedAt ?? current?.lastReadAt ?? 0
      if (scopeChanged()) throw new Error("Session read scope changed")
      await enqueue({
        command: "session_mark_read",
        payload: { sessionId, readThrough },
        accountId: scope?.accountId,
        targetId: scope?.targetId,
      })
      if (scopeChanged()) throw new Error("Session read scope changed")
      await db.sessionState.put({
        sessionId,
        lastReadAt: Math.max(current?.lastReadAt ?? 0, readThrough),
        unreadCount: 0,
        updatedAt: readThrough,
      })
    })
    return
  }
  await markSessionReadOnHost(sessionId)
}

/** A delayed device read cannot clear messages that arrived after its snapshot. */
export async function markSessionReadOnHost(
  sessionId: string,
  readThrough?: number
): Promise<void> {
  const now = Date.now()
  const db = getDb()
  await db.transaction("rw", db.sessions, db.sessionState, async () => {
    if ((await db.sessions.where("id").equals(sessionId).count()) === 0) return
    const current = await db.sessionState.get(sessionId)
    const currentWatermark = current?.updatedAt ?? current?.lastReadAt ?? 0
    const updatedAt = Math.max(now, currentWatermark + 1)
    if (readThrough !== undefined && currentWatermark > readThrough) {
      // Still publish a new watermark: clients that optimistically cleared this
      // snapshot must learn that a newer message kept the room unread.
      if (current) await db.sessionState.put({ ...current, updatedAt })
      return
    }
    await db.sessionState.put({
      sessionId,
      lastReadAt: Math.max(
        current?.lastReadAt ?? 0,
        readThrough === undefined ? now : Math.min(readThrough, currentWatermark)
      ),
      unreadCount: 0,
      updatedAt,
    })
  })
}

/** Increment a session's unread counter by one. */
export async function bumpUnread(sessionId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.sessions, db.sessionState, async () => {
    if ((await db.sessions.where("id").equals(sessionId).count()) === 0) return
    const cur = await db.sessionState.get(sessionId)
    await db.sessionState.put({
      sessionId,
      lastReadAt: cur?.lastReadAt ?? 0,
      unreadCount: (cur?.unreadCount ?? 0) + 1,
      updatedAt: Math.max(Date.now(), (cur?.updatedAt ?? cur?.lastReadAt ?? 0) + 1),
    })
  })
}
