/**
 * `workflowDeployments` companion sync handler.
 *
 * One row per workflow and environment, read by the Inbox override form to
 * offer a conversation the workflows that are actually published. Every host
 * writer stamps the indexed `updatedAt` and a deployment is disabled in place
 * rather than deleted, so this is a plain range mirror with no tombstones.
 * Publishing stays on the host.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { WorkflowDeployment } from "@/types/workflow/deployment"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncWorkflowDeployments(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<WorkflowDeployment>(
    {
      table: "workflowDeployments",
      getTable: () => getDb().workflowDeployments,
    },
    transport,
    cursor
  )
}
