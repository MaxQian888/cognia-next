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

import Dexie from "dexie"

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
  since: number,
  until = Infinity
): Promise<{ ids: string[]; maxDeletedAt: number }> {
  let rows: SyncTombstoneRow[]
  try {
    rows = await getDb()
      .syncTombstones.where("deletedAt")
      .between(since, until, false, true)
      .filter((row) => row.table === table)
      .toArray()
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
 * central storage retention sweeper. Kept bounded so the table doesn't grow without
 * limit on a long-lived desktop install; a phone that has been offline
 * longer than the retention window re-pulls from `since: 0` anyway (its
 * cursor would have been reset by a "Resync from scratch") and gets a full
 * snapshot, so pruned tombstones can't strand stale rows on it.
 */
export async function pruneTombstones(
  retentionMs: number = TOMBSTONE_RETENTION_MS,
  now: number = Date.now()
): Promise<number> {
  const db = getDb()
  let removed = 0
  try {
    // A missing parent alone is not deletion evidence: optimistic drafts and
    // partially synced histories can legitimately precede the session row.
    // Reconcile only explicit session deletions, before their evidence expires.
    let after: string | number = Dexie.minKey
    const upper = await db.syncTombstones.where("table").equals("sessions").last()
    while (upper) {
      const page: SyncTombstoneRow[] = await db.syncTombstones
        .where("[table+id]")
        .between(["sessions", after], ["sessions", upper.id], false, true)
        .limit(250)
        .toArray()
      if (page.length === 0) break
      after = page[page.length - 1].id
      removed += await db.transaction(
        "rw",
        [
          db.sessions,
          db.messages,
          db.syncTombstones,
          db.chatDrafts,
          db.sessionState,
          db.chatInputHistory,
          db.chatTurnSummaries,
          db.chatTranscriptIndexState,
          db.messageMediaRefs,
          db.messageMedia,
        ],
        async () => {
          // Re-read markers inside the write transaction; a restore or another
          // sweeper may have changed either the marker or parent since paging.
          const markers = (
            await db.syncTombstones.bulkGet(page.map((row) => ["sessions", row.id]))
          ).filter((row): row is SyncTombstoneRow => row !== undefined)
          const ids = markers.map((row) => row.id)
          const live = new Set(await db.sessions.where("id").anyOf(ids).primaryKeys())
          const history = new Set(await db.messages.where("sessionId").anyOf(ids).uniqueKeys())
          const deleted = ids.filter((id) => !live.has(id) && !history.has(id))
          let count = 0
          const pendingMediaSessions = new Set<string>()
          if (deleted.length > 0) {
            const refs = await db.messageMediaRefs.where("sessionId").anyOf(deleted).toArray()
            const hashes = [...new Set(refs.map((row) => row.hash))]
            count += await db.chatDrafts.where("sessionId").anyOf(deleted).delete()
            count += await db.sessionState.where("sessionId").anyOf(deleted).delete()
            count += await db.chatInputHistory.where("sessionId").anyOf(deleted).delete()
            count += await db.chatTurnSummaries.where("sessionId").anyOf(deleted).delete()
            count += await db.chatTranscriptIndexState.where("sessionId").anyOf(deleted).count()
            await db.chatTranscriptIndexState.bulkDelete(deleted)
            count += await db.messageMediaRefs.where("sessionId").anyOf(deleted).delete()
            if (hashes.length > 0) {
              // Use this captured database throughout the transaction, including
              // the same indexed reference re-check and media grace window as GC.
              const referenced = new Set(
                await db.messageMediaRefs.where("hash").anyOf(hashes).uniqueKeys()
              )
              const expired: string[] = []
              const recent = new Set<string>()
              // Read at most one blob at a time, even if a deleted session had
              // thousands of attachments. Keep only hash metadata in memory.
              for (const hash of hashes) {
                if (referenced.has(hash)) continue
                const row = await db.messageMedia.get(hash)
                if (!row) continue
                if (now - row.createdAt >= 60_000) expired.push(hash)
                else recent.add(hash)
              }
              await db.messageMedia.bulkDelete(expired)
              count += expired.length
              // Retain a retry path for blobs still inside the upload grace
              // window; otherwise removing the marker/ref loses their candidates.
              const pendingRefs = refs.filter((row) => recent.has(row.hash))
              await db.messageMediaRefs.bulkPut(pendingRefs)
              count -= pendingRefs.length
              for (const ref of pendingRefs) pendingMediaSessions.add(ref.sessionId)
            }
          }
          const expired = markers.filter(
            (row) =>
              row.deletedAt < now - retentionMs &&
              !pendingMediaSessions.has(row.id) &&
              (live.has(row.id) || !history.has(row.id))
          )
          await db.syncTombstones.bulkDelete(expired.map((row) => [row.table, row.id]))
          return count + expired.length
        }
      )
    }
    removed += await db.syncTombstones
      .where("deletedAt")
      .below(now - retentionMs)
      .and((row) => row.table !== "sessions")
      .delete()
  } catch (error) {
    // A failed page rolls back both the cleanup and its deletion evidence.
    // Later sweeps can retry; previously committed pages remain reclaimed.
    console.warn("tombstone retention cleanup failed", error)
  }
  return removed
}
