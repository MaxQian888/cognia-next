import type { Character } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull character upserts + tombstones from the desktop into local Dexie.
 *
 * Built-in characters (`isBuiltIn === true`) are filtered server-side
 * already, but we double-check client-side so a stale row never wipes a
 * locally-seeded built-in by accident.
 */
export function syncCharacters(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<Character>(
    {
      table: "characters",
      getTable: () => getDb().characters,
      rowFilter: (row) => !row.isBuiltIn,
    },
    transport,
    cursor
  )
}
