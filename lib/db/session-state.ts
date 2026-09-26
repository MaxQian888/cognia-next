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
  /**
   * Set only by an explicit "mark unread" ({@link markSessionUnreadOnHost}):
   * `at` is the watermark that write stamped, `from` the watermark it was taken
   * over. Every other writer replaces the row without it, so it is live only
   * while the manual unread is still the latest change — which is exactly when
   * a device read covering `from` may clear it. Non-indexed, no version bump.
   */
  manualUnread?: { at: number; from: number }
}

export async function getSessionState(sessionId: string): Promise<SessionStateRow | undefined> {
  return getDb().sessionState.get(sessionId)
}

export async function listSessionStates(): Promise<SessionStateRow[]> {
  return getDb().sessionState.toArray()
}

/**
 * Where a read/unread write for `sessionId` must land, resolved once per call.
 *
 * `remote` is a paired client whose `sessionState` is the Host's mirror: the
 * write goes to the Host through the durable outbound queue, with an
 * optimistic local copy. A conversation whose history this browser owns
 * (`local` history mode) stays local even while paired. `scopeChanged` fences
 * every await: a write that started under one account/target must not land in
 * another's database or queue.
 */
async function resolveSessionStateRoute(sessionId: string): Promise<{
  database: ReturnType<typeof getDb>
  scope: ReturnType<typeof getActiveRuntimeTargetContext>
  scopeChanged: () => boolean
  remote: boolean
} | null> {
  const database = getDb()
  const scope = getActiveRuntimeTargetContext()
  const scopeKey = JSON.stringify(scope)
  const scopeChanged = () =>
    getDb() !== database || JSON.stringify(getActiveRuntimeTargetContext()) !== scopeKey
  const { getRuntimeSnapshot } = await import("@/lib/runtime/runtime-snapshot-store")
  const { isRemoteHostActive } = await import("@/lib/tauri/transport-routing")
  const remote = isRemoteHostActive() || getRuntimeSnapshot().target?.kind === "companion"
  if (scopeChanged()) return null
  const localHistory =
    remote &&
    (await import("@/lib/sync/session-history")).getSessionHistoryMode(sessionId) === "local"
  if (scopeChanged()) return null
  return { database, scope, scopeChanged, remote: remote && !localHistory }
}

/**
 * The outbound-queue channel that orders one session's read/unread relay.
 *
 * Read and unread are opposite writes to the same row, so the Host must apply
 * them in the order the user made them — a read retried after a flaky link
 * must not land after the "mark unread" the user chose next. The queue only
 * orders rows that share a channel (`claimNext`'s channel-head rule), so both
 * commands carry this one.
 */
export function sessionStateRelayChannel(sessionId: string): string {
  return `session-state:${sessionId}`
}

/** Stable `clientId` for {@link sessionStateRelayChannel} rows. */
export const SESSION_STATE_RELAY_CLIENT_ID = "session-state-relay"

/** One past the highest sequence still outstanding on the session's relay channel. */
async function nextSessionStateRelaySeq(
  db: ReturnType<typeof getDb>,
  channel: string
): Promise<number> {
  const outstanding = await db.mobileOutboundQueue
    .where("status")
    .anyOf(["pending", "sending"])
    .filter((row) => row.channel === channel)
    .toArray()
  return (
    outstanding.reduce(
      (highest, row) =>
        typeof row.clientSeq === "number" ? Math.max(highest, row.clientSeq) : highest,
      0
    ) + 1
  )
}

/** Mark a session as read — clears unread count and bumps the read pointer. */
export async function markSessionRead(sessionId: string): Promise<void> {
  const route = await resolveSessionStateRoute(sessionId)
  if (!route) return
  const { database: db, scope, scopeChanged } = route
  if (route.remote) {
    const { enqueue } = await import("./mobile-outbound-queue")
    if (scopeChanged()) return
    await db.transaction("rw", db.sessions, db.sessionState, db.mobileOutboundQueue, async () => {
      if ((await db.sessions.where("id").equals(sessionId).count()) === 0) return
      const current = await db.sessionState.get(sessionId)
      const readThrough = current?.updatedAt ?? current?.lastReadAt ?? 0
      const channel = sessionStateRelayChannel(sessionId)
      const clientSeq = await nextSessionStateRelaySeq(db, channel)
      if (scopeChanged()) throw new Error("Session read scope changed")
      await enqueue({
        command: "session_mark_read",
        payload: { sessionId, readThrough },
        accountId: scope?.accountId,
        targetId: scope?.targetId,
        channel,
        clientId: SESSION_STATE_RELAY_CLIENT_ID,
        clientSeq,
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

/**
 * A delayed device read cannot clear messages that arrived after its snapshot.
 *
 * The one later write it MAY clear is a manual "mark unread" taken from the
 * snapshot it read (`manualUnread.from <= readThrough`): that is the user
 * changing their mind, not new activity, and without this exception a phone
 * that marked a chat unread and then opened it would leave it unread forever.
 */
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
    const supersedesManualUnread =
      readThrough !== undefined &&
      current?.manualUnread !== undefined &&
      current.manualUnread.at === currentWatermark &&
      current.manualUnread.from <= readThrough
    if (readThrough !== undefined && currentWatermark > readThrough && !supersedesManualUnread) {
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

/**
 * Mark a session as unread — the user's explicit "come back to this later".
 *
 * Sets `unreadCount` to at least 1 (an existing count is kept, never lowered)
 * and leaves `lastReadAt` where it is. Two paths, exactly like
 * {@link markSessionRead}: a paired client relays `session_mark_unread` to the
 * Host through the durable queue and applies the same change optimistically in
 * that transaction; the Host (or a standalone device) writes it directly. A
 * session with no row in `sessions` is a no-op on both paths.
 */
export async function markSessionUnread(sessionId: string): Promise<void> {
  const route = await resolveSessionStateRoute(sessionId)
  if (!route) return
  const { database: db, scope, scopeChanged } = route
  if (route.remote) {
    const { enqueue } = await import("./mobile-outbound-queue")
    if (scopeChanged()) return
    await db.transaction("rw", db.sessions, db.sessionState, db.mobileOutboundQueue, async () => {
      if ((await db.sessions.where("id").equals(sessionId).count()) === 0) return
      const current = await db.sessionState.get(sessionId)
      const channel = sessionStateRelayChannel(sessionId)
      const clientSeq = await nextSessionStateRelaySeq(db, channel)
      if (scopeChanged()) throw new Error("Session unread scope changed")
      await enqueue({
        command: "session_mark_unread",
        payload: { sessionId },
        accountId: scope?.accountId,
        targetId: scope?.targetId,
        channel,
        clientId: SESSION_STATE_RELAY_CLIENT_ID,
        clientSeq,
      })
      if (scopeChanged()) throw new Error("Session unread scope changed")
      // The watermark stays the Host's: it is what a later read on this device
      // reports as `readThrough`, and what lets that read supersede this unread.
      await db.sessionState.put({
        sessionId,
        lastReadAt: current?.lastReadAt ?? 0,
        unreadCount: Math.max(1, current?.unreadCount ?? 0),
        updatedAt: current?.updatedAt ?? current?.lastReadAt ?? 0,
      })
    })
    return
  }
  await markSessionUnreadOnHost(sessionId)
}

/**
 * The Host side of {@link markSessionUnread}. Idempotent: repeating it keeps
 * the count and the `manualUnread.from` of the first one, so a device read
 * taken before the repeats can still supersede them.
 */
export async function markSessionUnreadOnHost(sessionId: string): Promise<void> {
  const now = Date.now()
  const db = getDb()
  await db.transaction("rw", db.sessions, db.sessionState, async () => {
    if ((await db.sessions.where("id").equals(sessionId).count()) === 0) return
    const current = await db.sessionState.get(sessionId)
    const currentWatermark = current?.updatedAt ?? current?.lastReadAt ?? 0
    // Stamped like `bumpUnread` so the change crosses the sync watermark.
    const updatedAt = Math.max(now, currentWatermark + 1)
    const from =
      current?.manualUnread !== undefined && current.manualUnread.at === currentWatermark
        ? current.manualUnread.from
        : currentWatermark
    await db.sessionState.put({
      sessionId,
      lastReadAt: current?.lastReadAt ?? 0,
      unreadCount: Math.max(1, current?.unreadCount ?? 0),
      updatedAt,
      manualUnread: { at: updatedAt, from },
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
