/**
 * `executionRunBindings` companion sync handler.
 *
 * The run-to-conversation delivery bindings behind the Inbox delegation and
 * topic-runtime chips. `executionRuns` already mirrors the run itself but
 * cannot say which conversation it was delegated from. These rows can. The
 * host cursors on the required `updatedAt` (stamped by every writer, filled
 * in by `updateExecutionRunBinding` when a patch omits it) and never deletes
 * a binding, so there are no tombstones. Run control travels back as RPCs.
 * The client never writes a binding.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ExecutionRunBinding } from "@/types/execution/run"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncExecutionRunBindings(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<ExecutionRunBinding>(
    {
      table: "executionRunBindings",
      getTable: () => getDb().executionRunBindings,
    },
    transport,
    cursor
  )
}
