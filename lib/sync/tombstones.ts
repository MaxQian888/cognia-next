/**
 * Desktop-side tombstone store for the companion sync protocol (v61).
 *
 * V1 of `sync_pull` always returned `deleted_ids: []`, so a row deleted on
 * the desktop lingered forever on a paired phone. This module records one
 * tombstone per *genuine* user deletion (session / message / workflow /
 * character) inside the same Dexie transaction as the delete, and exposes
 * a reader the desktop sync source folds into each table's delta.
 *
 * Deliberately NOT wired into `persistMessages`' diff-based `bulkDelete`:
 * those removals are streaming churn (a placeholder row replaced mid-turn),
 * not user intent, and tombstoning them would make the phone drop live
 * messages. Only the explicit delete entry points record tombstones.
 *
 * The Dexie table (`syncTombstones: "[table+id], table, deletedAt"`) lives
 * in `lib/db/schema.ts` v61. `[table+id]` is the unique PK so re-deleting a
 * recreated id just overwrites the older tombstone; `table` and `deletedAt`
 * are indexed for the per-table read and the retention prune.
 */

import { getDb } from "@/lib/db/schema"

import type { SyncTombstoneRow, SyncableTable } from "./types"

/** Default retention for tombstone rows — pruned on boot. */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Record a tombstone per id for `table`. Idempotent (PK is `[table+id]`).
 * No-op on an empty list. Failures are swallowed so a tombstone-write
 * failure never blocks the user-visible delete that triggered it — the
 * worst case is a desktop deletion that doesn't propagate, i.e. the
 * pre-v61 behaviour.
 *
 * Pass `at` to share a single timestamp across a cascade (so a session and
 * its messages tombstone at the same watermark).
 */
export async function recordTombstones(
  table: SyncableTable,
  ids: readonly string[],
  at: number = Date.now(),
  host?: { generation: number; sequence: number }
): Promise<void> {
  if (ids.length === 0) return
  const rows: SyncTombstoneRow[] = ids.map((id) => ({
    table,
    id,
    deletedAt: at,
    ...(host ? { hostGeneration: host.generation, hostSeq: host.sequence } : {}),
  }))
  try {
    await getDb().syncTombstones.bulkPut(rows)
  } catch {
    // Swallowed — see jsdoc. A missing tombstone degrades to pre-v61
    // behaviour (deletion not mirrored), never a thrown error on delete.
  }
}

/**
 * Read every tombstone for `table` newer than `since`. Returns the deleted
 * ids and the highest `deletedAt` so the caller can fold it into the
 * delta's `next_since` watermark (the cursor advances past applied
 * tombstones, so each is sent to the phone exactly once).
 */
export async function readTombstonesSince(
  table: SyncableTable,
  since: number
): Promise<{ ids: string[]; maxDeletedAt: number }> {
  let rows: SyncTombstoneRow[]
  try {
    rows = await getDb().syncTombstones.where("table").equals(table).toArray()
  } catch {
    return { ids: [], maxDeletedAt: since }
  }
  const ids: string[] = []
  let maxDeletedAt = since
  for (const row of rows) {
    if (row.deletedAt > since) {
      ids.push(row.id)
      if (row.deletedAt > maxDeletedAt) maxDeletedAt = row.deletedAt
    }
  }
  return { ids, maxDeletedAt }
}

/**
 * Drop tombstones older than `retentionMs`. Called once at boot from the
 * companion boot provider. Kept bounded so the table doesn't grow without
 * limit on a long-lived desktop install; a phone that has been offline
 * longer than the retention window re-pulls from `since: 0` anyway (its
 * cursor would have been reset by a "Resync from scratch") and gets a full
 * snapshot, so pruned tombstones can't strand stale rows on it.
 */
export async function pruneTombstones(
  retentionMs: number = TOMBSTONE_RETENTION_MS,
  now: number = Date.now()
): Promise<void> {
  try {
    await getDb()
      .syncTombstones.where("deletedAt")
      .below(now - retentionMs)
      .delete()
  } catch {
    // Non-fatal — pruning is housekeeping; a failure just leaves old rows.
  }
}
