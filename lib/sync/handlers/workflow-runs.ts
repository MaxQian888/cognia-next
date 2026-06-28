import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { WorkflowRunRow } from "@/types/workflow/visual"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull workflow RUN history (creation + completion) from the desktop.
 *
 * Workflow *definitions* sync via `syncWorkflows`; this mirrors their runs so
 * the mobile library badges ("active"/"sending"), RecentRunsFeed,
 * MobileRunsList, and the home active-runs card reflect what actually ran —
 * including workflows the phone triggered, which previously vanished once
 * their outbound job was sent. Pull-only: runs are authored on the executing
 * desktop. The desktop side cursors on `max(startedAt, completedAt)` and pages
 * the first sync (see `desktop-sync-source.readWorkflowRunsDelta`).
 */
export function syncWorkflowRuns(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<WorkflowRunRow>(
    {
      table: "workflowRuns",
      getTable: () => getDb().workflowRuns,
    },
    transport,
    cursor
  )
}
