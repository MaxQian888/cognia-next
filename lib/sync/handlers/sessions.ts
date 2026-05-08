import type { ChatSession } from "@/lib/claude/types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncSessions(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<ChatSession>(
    {
      table: "sessions",
      getTable: () => getDb().sessions,
    },
    transport,
    cursor
  )
}
