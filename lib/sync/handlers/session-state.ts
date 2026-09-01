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
 * normal read path, which writes locally and is mirrored back on the next pull.
 */
export function syncSessionState(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<SessionStateSyncRow>(
    {
      table: "sessionState",
      getTable: () => getDb().sessionState as never,
      applyRows: async (rows) => {
        await getDb().sessionState.bulkPut(
          rows.map(({ id: _id, ...row }) => row as SessionStateRow)
        )
      },
    },
    transport,
    cursor
  )
}
