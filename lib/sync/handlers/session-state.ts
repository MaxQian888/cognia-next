import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { getDb } from "@/lib/db/schema"
import type { SessionStateRow } from "@/lib/db/session-state"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * The wire shape of a `sessionState` row.
 *
 * `runSyncHandler` is generic over `{ id: string }` because every other
 * syncable table has one. This table's primary key is `sessionId`, so the host
 * reader sends an `id` alias alongside it (`desktop-sync-source.ts`) and the
 * apply step below drops the alias again. Writing the row with a stray `id`
 * would work in IndexedDB and then quietly diverge from every desktop-written
 * row, which is the kind of difference that only shows up as a stale badge.
 */
type SessionStateSyncRow = SessionStateRow & { id: string }

/**
 * Pull per-session unread pointers from the host.
 *
 * This is what the mobile Chat tab badge and the Inbox dot count. Both used to
 * read `inboundLedger`, which is a host-only dedupe ledger and never syncs, so
 * both were permanently 0 on a paired device. `sessionState` is the same table
 * the desktop's own unread badges read, so the two shells now agree by
 * construction rather than by two implementations of "unread" that drifted.
 *
 * Host-authoritative and read-only here. The phone clears unread through the
 * durable read relay; a pending read covers only the Host snapshot the device
 * actually saw, so a later incoming message still lights the badge.
 */
export function syncSessionState(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<SessionStateSyncRow>(
    {
      table: "sessionState",
      getTable: () => getDb().sessionState as never,
      applyRows: async (rows, assertCurrent) => {
        const db = getDb()
        const scope = getActiveRuntimeTargetContext()
        await db.transaction("rw", db.sessionState, db.mobileOutboundQueue, async () => {
          const pending = await db.mobileOutboundQueue
            .where("status")
            .anyOf(["pending", "sending"])
            .filter(
              (job) =>
                (job.command === "session_mark_read" || job.command === "session_mark_unread") &&
                job.accountId === scope?.accountId &&
                job.targetId === scope?.targetId
            )
            .toArray()
          assertCurrent()
          // The user's most recent read/unread choice per session. Both relay
          // on one ordered channel, so the latest one is what the Host will end
          // on once the queue drains — and what the row must show until then.
          const latestChoice = new Map<string, (typeof pending)[number]>()
          // Fold once per slice instead of rescanning the queue for each row.
          const readThroughBySession = new Map<string, number>()
          for (const job of pending) {
            const sessionId = job.payload.sessionId
            if (typeof sessionId !== "string") continue
            if (
              job.command === "session_mark_read" &&
              typeof job.payload.readThrough === "number"
            ) {
              readThroughBySession.set(
                sessionId,
                Math.max(readThroughBySession.get(sessionId) ?? -1, job.payload.readThrough)
              )
            }
            const previous = latestChoice.get(sessionId)
            if (
              !previous ||
              job.createdAt > previous.createdAt ||
              (job.createdAt === previous.createdAt &&
                (job.clientSeq ?? 0) > (previous.clientSeq ?? 0))
            ) {
              latestChoice.set(sessionId, job)
            }
          }
          await db.sessionState.bulkPut(
            rows.map(({ id: _id, ...row }) => {
              if (latestChoice.get(row.sessionId)?.command === "session_mark_unread") {
                // A pending "mark unread" is not undone by a Host row that has
                // not applied it yet.
                return { ...row, unreadCount: Math.max(1, row.unreadCount) } as SessionStateRow
              }
              const readThrough = readThroughBySession.get(row.sessionId) ?? -1
              const watermark = row.updatedAt ?? row.lastReadAt
              // Same rule the Host applies (`markSessionReadOnHost`): a read
              // covers everything up to its snapshot, and also a manual unread
              // taken over that snapshot — the user changed their mind again.
              const covered =
                readThrough >= watermark ||
                (readThrough >= 0 &&
                  row.manualUnread !== undefined &&
                  row.manualUnread.at === watermark &&
                  row.manualUnread.from <= readThrough)
              return covered
                ? { ...row, unreadCount: 0, lastReadAt: Math.max(row.lastReadAt, readThrough) }
                : (row as SessionStateRow)
            })
          )
        })
      },
    },
    transport,
    cursor
  )
}
