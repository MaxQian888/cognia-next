/**
 * `connectorHeartbeats` companion sync handler.
 *
 * The Inbox health badge and the connection-loss banner read the newest
 * heartbeat per adapter, and a thin client had no way to obtain one. The host
 * pages them on `at` (`readConnectorHeartbeatsDelta`), floors a first pull to
 * the last hour, and prunes its own table after 48 h WITHOUT tombstones. So
 * the mirror ages itself out on the same window, batch-limited so one apply
 * never turns into an unbounded delete.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ConnectorHeartbeatRow } from "@/lib/db/connector-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Same window as the host's `HEARTBEAT_RETENTION_MS`
 * (`lib/connectors/health/heartbeat.ts`), restated here rather than imported
 * so the sync bundle does not drag the connector runtime in. The test pins
 * the two equal.
 */
export const MIRROR_HEARTBEAT_RETENTION_MS = 48 * 60 * 60 * 1000
/** Max aged-out rows deleted per pull, which bounds one apply's IDB work. */
export const MIRROR_HEARTBEAT_SWEEP_BATCH = 1000

/** Delete mirrored heartbeats older than the retention window. */
export async function sweepAgedMirroredHeartbeats(now: number = Date.now()): Promise<number> {
  const table = getDb().connectorHeartbeats
  const ids = (await table
    .where("at")
    .below(now - MIRROR_HEARTBEAT_RETENTION_MS)
    .limit(MIRROR_HEARTBEAT_SWEEP_BATCH)
    .primaryKeys()) as string[]
  if (ids.length === 0) return 0
  await table.bulkDelete(ids)
  return ids.length
}

export async function applyConnectorHeartbeatRows(
  rows: ConnectorHeartbeatRow[],
  now: number = Date.now()
): Promise<void> {
  if (rows.length > 0) await getDb().connectorHeartbeats.bulkPut(rows)
  await sweepAgedMirroredHeartbeats(now)
}

export function syncConnectorHeartbeats(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<ConnectorHeartbeatRow>(
    {
      table: "connectorHeartbeats",
      getTable: () => getDb().connectorHeartbeats,
      applyRows: (rows) => applyConnectorHeartbeatRows(rows),
    },
    transport,
    cursor
  )
}
