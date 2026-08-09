import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ExecutionRun } from "@/types/execution/run"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/** Pull canonical, remote-safe execution summaries from the executing host. */
export function syncExecutionRuns(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<ExecutionRun>(
    {
      table: "executionRuns",
      getTable: () => getDb().executionRuns,
    },
    transport,
    cursor
  )
}
