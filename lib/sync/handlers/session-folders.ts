/**
 * `sessionFolders` companion sync handler.
 *
 * The Host's conversation folders, mirrored so a paired device files its
 * conversation list into the same sections the Host does. Every Host writer
 * (`lib/db/session-folders.ts`) stamps the indexed `updatedAt`, and a deleted
 * folder arrives as a tombstone, so this is a plain range mirror.
 *
 * Read-only here, like every sync table: a folder written on this device goes
 * to the Host as a `folder.*` HostState intent and comes back through this
 * pull. The one row this handler may overwrite that the Host did not send is
 * the optimistic row of a `folder.create` — under the id the Host adopted, so
 * the pulled row simply replaces it.
 */

import type { SessionFolder } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncSessionFolders(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<SessionFolder>(
    {
      table: "sessionFolders",
      getTable: () => getDb().sessionFolders,
    },
    transport,
    cursor
  )
}
