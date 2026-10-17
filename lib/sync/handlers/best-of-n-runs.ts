import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { BestOfNRunSummary } from "@/types/best-of-n"
import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/** One-way mirror only. A synced selection never grants authority to publish. */
export function syncBestOfNRuns(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<BestOfNRunSummary>(
    {
      table: "bestOfNRuns",
      getTable: () => getDb().bestOfNRuns,
      applyRows: async (rows, assertCurrent) => {
        const db = getDb()
        await db.transaction("rw", db.bestOfNRuns, async () => {
          for (const row of rows) {
            assertCurrent()
            if (!row.group || row.id !== row.group.groupId)
              throw new Error("Invalid Best-of-N summary")
            const previous = await db.bestOfNRuns.get(row.id)
            if (
              !previous ||
              row.group.version > previous.group.version ||
              (row.group.version === previous.group.version && row.updatedAt >= previous.updatedAt)
            ) {
              await db.bestOfNRuns.put(row)
            }
          }
        })
      },
    },
    transport,
    cursor
  )
}
