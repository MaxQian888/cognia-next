// Dexie CRUD for the Unified Notification Center (ADR-0042, table v68).
//
// Raw persistence only — coalescing, read-state cascade, routing and retention
// POLICY live in `lib/notifications/*` (pure, DI-tested). This module is the
// thin DB surface those policies call. Mirrors `lib/db/backup-history.ts`.

import type {
  NotificationRecord,
  NotificationSource,
  NotificationReadState,
} from "@/types/notifications"
import { getDb } from "./schema"

export interface NotificationListFilter {
  source?: NotificationSource
  /** Read states to include (default: all except "done"). */
  readStates?: NotificationReadState[]
  /** Include archived ("done") records. Default false. */
  includeDone?: boolean
  /** Hide records snoozed past `now`. Pass `now` to activate. */
  hideSnoozedAfter?: number
  limit?: number
}

/** Insert or replace a record. */
export async function putNotification(rec: NotificationRecord): Promise<void> {
  await getDb().notifications.put(rec)
}

export async function getNotification(id: string): Promise<NotificationRecord | undefined> {
  return getDb().notifications.get(id)
}

/**
 * Most-recent non-done record matching `dedupeKey` last touched (`updatedAt`)
 * at/after `sinceMs`. Recency is measured by last activity so the coalescing
 * policy can bump an existing row instead of inserting (REGULAR vs BACKOFF is
 * decided by `lib/notifications/dedup`).
 */
export async function findByDedupeKey(
  dedupeKey: string,
  sinceMs: number
): Promise<NotificationRecord | undefined> {
  const rows = await getDb()
    .notifications.where("dedupeKey")
    .equals(dedupeKey)
    .filter((r) => r.updatedAt >= sinceMs && r.readState !== "done")
    .toArray()
  if (rows.length === 0) return undefined
  // Newest by updatedAt.
  return rows.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
}

/** Patch selected fields of an existing record. No-op if it's gone. */
export async function patchNotification(
  id: string,
  patch: Partial<NotificationRecord>
): Promise<void> {
  await getDb().notifications.update(id, patch)
}

/** Newest-first list, filtered. */
export async function listNotifications(
  filter: NotificationListFilter = {}
): Promise<NotificationRecord[]> {
  let coll = getDb().notifications.orderBy("createdAt").reverse()

  coll = coll.filter((r) => {
    if (filter.source && r.source !== filter.source) return false
    if (!filter.includeDone && r.readState === "done") return false
    if (filter.readStates && !filter.readStates.includes(r.readState)) return false
    if (
      filter.hideSnoozedAfter !== undefined &&
      r.snoozedUntil !== undefined &&
      r.snoozedUntil > filter.hideSnoozedAfter
    ) {
      return false
    }
    return true
  })

  if (filter.limit && filter.limit > 0) coll = coll.limit(filter.limit)
  return coll.toArray()
}

/**
 * Badge counts. `directedUnread` is the red numeric badge (directed + not yet
 * read, not snoozed); `ambientUnseen` is the plain activity dot.
 */
export async function getBadgeCounts(
  now: number
): Promise<{ directedUnread: number; ambientUnseen: number }> {
  let directedUnread = 0
  let ambientUnseen = 0
  await getDb()
    .notifications.where("readState")
    .anyOf("unseen", "seen")
    .each((r) => {
      if (r.snoozedUntil !== undefined && r.snoozedUntil > now) return
      if (r.directed) directedUnread += 1
      if (r.readState === "unseen") ambientUnseen += 1
    })
  return { directedUnread, ambientUnseen }
}

/** Records whose `groupKey` matches — used by snooze auto-wake. */
export async function listByGroupKey(groupKey: string): Promise<NotificationRecord[]> {
  return getDb().notifications.where("groupKey").equals(groupKey).toArray()
}

export async function deleteNotification(id: string): Promise<void> {
  await getDb().notifications.delete(id)
}

export async function clearNotifications(): Promise<void> {
  await getDb().notifications.clear()
}

/**
 * Enforce retention: drop expired (`expiresAt <= now`), then records older than
 * `maxAgeMs`, then trim to the newest `maxItems`. Runs in one transaction.
 * Returns the number of pruned rows.
 */
export async function pruneNotifications(opts: {
  now: number
  maxAgeMs: number
  maxItems: number
}): Promise<number> {
  const db = getDb()
  let removed = 0
  await db.transaction("rw", db.notifications, async () => {
    // 1. TTL-expired.
    const expiredKeys = await db.notifications
      .where("expiresAt")
      .belowOrEqual(opts.now)
      .primaryKeys()
    if (expiredKeys.length > 0) {
      await db.notifications.bulkDelete(expiredKeys as string[])
      removed += expiredKeys.length
    }

    // 2. Older than maxAge.
    if (opts.maxAgeMs > 0) {
      const cutoff = opts.now - opts.maxAgeMs
      const oldKeys = await db.notifications.where("createdAt").below(cutoff).primaryKeys()
      if (oldKeys.length > 0) {
        await db.notifications.bulkDelete(oldKeys as string[])
        removed += oldKeys.length
      }
    }

    // 3. Trim to newest maxItems.
    if (opts.maxItems > 0) {
      const total = await db.notifications.count()
      if (total > opts.maxItems) {
        const toRemove = total - opts.maxItems
        const oldest = await db.notifications.orderBy("createdAt").limit(toRemove).primaryKeys()
        if (oldest.length > 0) {
          await db.notifications.bulkDelete(oldest as string[])
          removed += oldest.length
        }
      }
    }
  })
  return removed
}
