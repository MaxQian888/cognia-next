/**
 * `connectorCallbackBindings` companion sync handler.
 *
 * Read by the Inbox callback-bindings inspector. The host cursors on
 * max(createdAt, consumedAt) (`readConnectorCallbackBindingsDelta`) and reaps
 * expired rows by TTL without tombstones, so the mirror expires rows on their
 * own `expiresAt`, or, for legacy rows that carry none, after the same grace
 * the host's cleanup applies. A mirrored binding is inert: callbacks are
 * authorized and consumed on the host, and nothing on a thin client reads
 * this table to dispatch.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Same grace as the host's `LEGACY_GRACE_MS`
 * (`lib/connectors/callback-binding-cleanup.ts`), restated so the sync bundle
 * does not import the audit writer. The test pins the two equal.
 */
export const MIRROR_BINDING_LEGACY_GRACE_MS = 60 * 24 * 60 * 60 * 1000
/** Max expired rows deleted per pull, which bounds one apply's IDB work. */
export const MIRROR_BINDING_SWEEP_BATCH = 500

/** When a mirrored binding stops being worth keeping. */
export function bindingExpiresAt(
  row: Pick<ConnectorCallbackBindingRow, "createdAt" | "expiresAt">
): number {
  return row.expiresAt ?? row.createdAt + MIRROR_BINDING_LEGACY_GRACE_MS
}

/** Delete mirrored bindings whose expiry has passed. */
export async function sweepExpiredMirroredBindings(now: number = Date.now()): Promise<number> {
  const table = getDb().connectorCallbackBindings
  const victims = await table
    .filter((row) => bindingExpiresAt(row) < now)
    .limit(MIRROR_BINDING_SWEEP_BATCH)
    .primaryKeys()
  if (victims.length === 0) return 0
  await table.bulkDelete(victims as string[])
  return victims.length
}

export async function applyConnectorCallbackBindingRows(
  rows: ConnectorCallbackBindingRow[],
  now: number = Date.now()
): Promise<void> {
  if (rows.length > 0) await getDb().connectorCallbackBindings.bulkPut(rows)
  await sweepExpiredMirroredBindings(now)
}

export function syncConnectorCallbackBindings(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<ConnectorCallbackBindingRow>(
    {
      table: "connectorCallbackBindings",
      getTable: () => getDb().connectorCallbackBindings,
      applyRows: (rows) => applyConnectorCallbackBindingRows(rows),
    },
    transport,
    cursor
  )
}
