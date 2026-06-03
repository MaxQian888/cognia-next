/**
 * CRUD for the `remoteControlAudit` table (schema v72, ADR-0005 activation).
 *
 * A durable audit trail for the remote-control plane: one row per inbound
 * command dispatch and per outbound delivery attempt. Unlike the transient
 * in-memory ring buffer (cap 20) surfaced in the Overview tab, these rows
 * survive restart so "who triggered what remotely, and when" is answerable
 * after the fact — the baseline expectation for a privileged control plane.
 *
 * Append-only with a bounded retention sweep (`MAX_ROWS` newest kept).
 */

import type { RemoteControlAuditDirection, RemoteControlAuditEntry } from "@/types/remote-control"
import { getDb } from "./schema"

const MAX_ROWS = 1000

/**
 * Append an audit row. `id` + `at` are generated unless supplied (tests pin
 * `at` for ordering assertions).
 */
export async function appendRemoteControlAudit(
  entry: Omit<RemoteControlAuditEntry, "id" | "at"> & { id?: string; at?: number }
): Promise<void> {
  const row: RemoteControlAuditEntry = {
    ...entry,
    id: entry.id ?? crypto.randomUUID(),
    at: entry.at ?? Date.now(),
  }
  await getDb().remoteControlAudit.add(row)
  await pruneRemoteControlAudit()
}

export interface ListRemoteControlAuditOptions {
  limit?: number
  direction?: RemoteControlAuditDirection
}

/** Newest-first list, optionally filtered by direction. */
export async function listRemoteControlAudit(
  opts: ListRemoteControlAuditOptions = {}
): Promise<RemoteControlAuditEntry[]> {
  let coll = getDb().remoteControlAudit.orderBy("at").reverse()
  if (opts.direction) {
    const dir = opts.direction
    coll = coll.filter((r) => r.direction === dir)
  }
  return coll.limit(opts.limit ?? 100).toArray()
}

/** Drop the oldest rows beyond `MAX_ROWS`. No-op under the cap. */
export async function pruneRemoteControlAudit(): Promise<void> {
  const table = getDb().remoteControlAudit
  const count = await table.count()
  if (count <= MAX_ROWS) return
  const excess = count - MAX_ROWS
  const oldest = await table.orderBy("at").limit(excess).primaryKeys()
  await table.bulkDelete(oldest)
}
