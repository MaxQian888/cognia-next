/**
 * `connectorDrafts` companion sync handler (ADR-0131 cross-shell inbox relay).
 *
 * Full-row mirror, host → thin client. The phone's `DraftApprovalPanel` and
 * the Inbox draft editor read this table; approvals / rejections travel back
 * as `connector_approve_draft` / `connector_reject_draft` RPCs
 * (`lib/connectors/inbox-writes/remote.ts`) after an optimistic local flip.
 *
 * Optimistic status wins over a stale pull: a row the client already moved
 * out of `pending` is not regressed to `pending` by a delta that predates the
 * host applying the client's own RPC — the next host-side write (which stamps
 * a newer `updatedAt`) replaces it.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export async function applyConnectorDraftRows(rows: ConnectorDraftRow[]): Promise<void> {
  const table = getDb().connectorDrafts
  const existing = await table.bulkGet(rows.map((row) => row.id))
  const toWrite: ConnectorDraftRow[] = []
  rows.forEach((row, index) => {
    const local = existing[index]
    if (local && local.status !== "pending" && row.status === "pending") {
      const localAt = local.updatedAt ?? local.createdAt
      const remoteAt = row.updatedAt ?? row.createdAt
      // Optimistic local decision newer than what the host has told us so far.
      if (localAt >= remoteAt) return
    }
    toWrite.push(row)
  })
  if (toWrite.length > 0) await table.bulkPut(toWrite)
}

export function syncConnectorDrafts(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<ConnectorDraftRow>(
    {
      table: "connectorDrafts",
      getTable: () => getDb().connectorDrafts,
      applyRows: applyConnectorDraftRows,
    },
    transport,
    cursor
  )
}
