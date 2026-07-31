import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Goal } from "@/types/goal"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull `/goal` console rows (`chatGoals`) from the desktop so the mobile
 * companion's Goals view can render progress offline. Read-mostly mirror —
 * goals are authored/driven on the desktop; the phone only displays them.
 */
export function syncGoals(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<Goal>(
    {
      table: "goals",
      getTable: () => getDb().chatGoals,
    },
    transport,
    cursor
  )
}
