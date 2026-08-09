import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"
import { mergePortableManagedContext } from "@/lib/task-workspace/managed-workspace"

export function syncSessions(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<ChatSession>(
    {
      table: "sessions",
      getTable: () => getDb().sessions,
      applyRows: async (rows) => {
        const table = getDb().sessions
        const existing = await table.bulkGet(rows.map((row) => row.id))
        await table.bulkPut(
          rows.map((row, index) => {
            if (!row.executionContext) return row
            return {
              ...row,
              executionContext: mergePortableManagedContext(
                row.executionContext,
                existing[index]?.executionContext
              ),
            }
          })
        )
      },
    },
    transport,
    cursor
  )
}
