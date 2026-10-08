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
      applyRows: async (rows, assertCurrent) => {
        const table = getDb().sessions
        const managedIds = rows
          .filter((row) => row.executionContext?.workspaceBinding?.kind === "managed")
          .map((row) => row.id)
        // Only managed bindings use device-local context. Keep the async scope
        // fence even when this slice needs no previous encrypted session rows.
        const existing: (ChatSession | undefined)[] = await (managedIds.length > 0
          ? table.bulkGet(managedIds)
          : [])
        const localContexts = new Map(
          existing
            .filter((row): row is ChatSession => row !== undefined)
            .map((row) => [row.id, row.executionContext])
        )
        assertCurrent()
        await table.bulkPut(
          rows.map((row) => {
            if (!row.executionContext) return row
            return {
              ...row,
              executionContext: mergePortableManagedContext(
                row.executionContext,
                localContexts.get(row.id)
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
