/**
 * Twin registry companion-sync handlers.
 *
 * The phone's `/discover` tab mounts a Twin selector, a profile panel, a
 * sources panel and a draft review queue. That is a complete surface which
 * rendered its empty state on every device, because the registry it selects
 * from was never mirrored and there is no `twin_list` command to ask for it
 * live. Sync is the only path, so these two handlers are what make that whole
 * tab exist off the desktop.
 *
 * Host-authoritative and read-mostly, like every other companion table.
 * Ingest (`twin_source_create`), review (`twin_draft_review`) and job control
 * travel back as RPCs through the mobile outbound queue, never as sync writes.
 *
 * Plain rows, no content envelope. `twins` and `twinDrafts` are classified
 * `encrypted-content`, but that classification is an at-rest, per-field
 * partition applied by `lib/db/encrypted-content-middleware.ts` on whichever
 * device holds the row: the Host decrypts on read, the row crosses the
 * authenticated companion channel, and the phone's own middleware encrypts it
 * again on write. That is what `sessions`, `messages`, `workflows`,
 * `twinProfile` and `connectorDrafts` already do. `memories` is the single
 * exception, and only because its text also lives in the RAG index under a
 * per-profile DEK, which is a retrieval concern rather than a sync one.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Twin, TwinDraft } from "@/types/twin"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/** Pull the Twin registry so the mobile Twin selector has something to select. */
export function syncTwins(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<Twin>(
    {
      table: "twins",
      getTable: () => getDb().twins as never,
    },
    transport,
    cursor
  )
}

/**
 * Pull distilled drafts.
 *
 * The Host stamps no `updatedAt` on a draft, so `readTwinDraftsDelta` sends a
 * synthetic one derived from `max(createdAt, reviewedAt)`. It is stripped here
 * rather than written: `TwinDraft` has no such field, and persisting one would
 * put a value in Dexie that every other reader of this table would then have
 * to learn to ignore.
 */
export function syncTwinDrafts(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<TwinDraft & { updatedAt?: number }>(
    {
      table: "twinDrafts",
      getTable: () => getDb().twinDrafts as never,
      applyRows: async (rows) => {
        const stripped = rows.map(({ updatedAt: _cursor, ...draft }) => draft as TwinDraft)
        await getDb().twinDrafts.bulkPut(stripped)
      },
    },
    transport,
    cursor
  )
}
