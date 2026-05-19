import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { WorkflowRow } from "@/types/workflow/visual"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull visual-workflow definition upserts + tombstones from the desktop.
 *
 * Built-in workflows ship with the app on every device, so we filter them
 * out client-side as a defensive measure mirroring `syncCharacters`.
 */
export function syncWorkflows(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<WorkflowRow>(
    {
      table: "workflows",
      getTable: () => getDb().workflows,
      rowFilter: (row) => !row.isBuiltIn,
    },
    transport,
    cursor
  )
}
