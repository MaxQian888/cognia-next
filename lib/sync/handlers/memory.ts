import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Memory } from "@/types/memory/memory"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull long-term `memories` from the desktop so the mobile companion can show
 * recalled memories offline. Read-mostly mirror — memories are written by the
 * desktop consolidation path; the phone only displays them.
 */
export function syncMemories(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<Memory>(
    {
      table: "memories",
      getTable: () => getDb().memories,
    },
    transport,
    cursor
  )
}
