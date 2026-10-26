/**
 * `sessionUsage` companion sync handler.
 *
 * An org member's turns run on the Host, which writes the only record of their
 * spend into the member's partition; the welcome dashboard (streaks, heatmap,
 * per-model breakdown) reads it from this mirror. Rows arrive keyed by `id`,
 * the reply's message id (`sessionUsageWireRow`), and are stored as the Host
 * holds them under that `messageId`. A turn this device also booked while its
 * chat view rendered it has the same key, so the Host's row replaces it
 * rather than counting the turn twice. Deleted conversations tombstone their
 * rows; the 90-day retention sweep runs on this device as on the Host.
 */

import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export type SessionUsageWireRow = SessionUsageRow & { id: string }

/** The stored row, or `null` for a malformed or locally scanned row. */
export function sessionUsageFromWire(row: SessionUsageWireRow): SessionUsageRow | null {
  if (
    !row ||
    typeof row.messageId !== "string" ||
    !row.messageId ||
    row.id !== row.messageId ||
    typeof row.sessionId !== "string" ||
    !Number.isFinite(row.at) ||
    row.sourceId
  ) {
    return null
  }
  const { id: _id, ...stored } = row
  return stored
}

export async function applySessionUsageRows(
  rows: SessionUsageWireRow[],
  assertCurrent: () => void = () => {}
): Promise<void> {
  const stored = rows.flatMap((row) => {
    const next = sessionUsageFromWire(row)
    return next ? [next] : []
  })
  if (stored.length === 0) return
  assertCurrent()
  await getDb().sessionUsage.bulkPut(stored)
}

export function syncSessionUsage(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<SessionUsageWireRow>(
    {
      table: "sessionUsage",
      getTable: () => getDb().sessionUsage as never,
      applyRows: applySessionUsageRows,
    },
    transport,
    cursor
  )
}
