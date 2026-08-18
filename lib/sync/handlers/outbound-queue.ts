/**
 * `outboundQueue` companion sync handler (ADR-0131 cross-shell inbox relay).
 *
 * Mirrors the host's outbound STATUS PROJECTION (see
 * `lib/sync/desktop-sync-source.ts:projectOutboundJobRow`): id / status /
 * error / attempts / timestamps / platform message id, `request.segments`
 * empty, `syncedFromHost: true`, `nextAttemptAt: 0`. Existing readers
 * (`OutboundStatusPill`, `useLatestOutboundJob`, `useOutboundSaturation`)
 * work unchanged; the local runner never dispatches a mirrored row
 * (`lib/db/outbound-jobs.ts:isLocallyDispatchable`).
 *
 * Two safety rails on apply:
 *   - every incoming row is FORCED to the projection shape (`syncedFromHost`,
 *     empty segments, `nextAttemptAt: 0`) even if a host ever sent more, so
 *     the "never dispatch locally" invariant does not depend on the host;
 *   - terminal projections older than {@link MIRROR_TERMINAL_RETENTION_MS}
 *     are aged out on every pull — the host prunes its own terminal rows
 *     after 14 days without tombstones, and the client must not keep them
 *     forever.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import { isOutboundTerminal, OUTBOUND_TERMINAL_RETENTION_MS } from "@/lib/db/outbound-jobs"
import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export const MIRROR_TERMINAL_RETENTION_MS = OUTBOUND_TERMINAL_RETENTION_MS
/** Max aged-out rows deleted per pull — bounds one apply's IDB work. */
export const MIRROR_SWEEP_BATCH = 500

export function normalizeMirroredOutboundRow(row: OutboundJobRow): OutboundJobRow {
  return {
    ...row,
    request: { ...row.request, segments: [] },
    nextAttemptAt: 0,
    syncedFromHost: true,
    updatedAt: row.updatedAt ?? row.createdAt,
  }
}

export async function applyOutboundQueueRows(
  rows: OutboundJobRow[],
  now: number = Date.now()
): Promise<void> {
  const table = getDb().outboundQueue
  if (rows.length > 0) await table.bulkPut(rows.map(normalizeMirroredOutboundRow))
  await sweepAgedMirroredRows(now)
}

/** Delete mirrored terminal projections older than the retention window. */
export async function sweepAgedMirroredRows(now: number = Date.now()): Promise<number> {
  const table = getDb().outboundQueue
  const victims = await table
    .where("createdAt")
    .below(now - MIRROR_TERMINAL_RETENTION_MS)
    .filter((row) => row.syncedFromHost === true && isOutboundTerminal(row.status))
    .limit(MIRROR_SWEEP_BATCH)
    .toArray()
  if (victims.length === 0) return 0
  await table.bulkDelete(victims.map((row) => row.id))
  return victims.length
}

export function syncOutboundQueue(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<OutboundJobRow>(
    {
      table: "outboundQueue",
      getTable: () => getDb().outboundQueue,
      applyRows: (rows) => applyOutboundQueueRows(rows),
    },
    transport,
    cursor
  )
}
