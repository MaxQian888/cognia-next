/**
 * Persistent Open VSX metadata cache.
 *
 * Backed by the **existing** `openVsxCache` Dexie table, created at schema v31
 * (`lib/db/schema.ts`) and — until now — never written by anyone; the only
 * other reference clears it (`lib/desktop/menu-actions.ts`). Its row type
 * `OpenVsxCacheRow` already matches the *live* API's field names
 * (`downloadCount` / `averageRating`), so **no Dexie version bump is needed**
 * and none is made here.
 *
 * ## Guards
 *
 * - **24h TTL** via `fetchedAt`. `getCached` treats a stale row as absent.
 * - **Row cap enforced on write.** The table's only index is
 *   `&extensionId, fetchedAt` and nothing has ever evicted from it, so without
 *   a cap a few hundred searches would grow it without bound. Eviction is by
 *   oldest `fetchedAt` — fetch time, not access time, because there is no
 *   access-time index to sort by. Re-caching an extension refreshes its
 *   `fetchedAt` and thus its position, which makes this LRU-shaped in practice.
 * - **Payload cap.** `payload` is typed `unknown` and is filled straight from a
 *   registry response. An oversized row is skipped entirely rather than
 *   truncated: a half-payload would be a lie the UI can't detect.
 */

import { getDb } from "@/lib/db/schema"
import type { OpenVsxCacheRow } from "@/types/plugin/vscode-extension-cache"
import type { OpenVsxQueryEntry, OpenVsxSearchEntry } from "./openvsx-client"

/** Rows older than this are stale. Matches the v31 schema comment. */
export const OPEN_VSX_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Maximum rows retained. Enforced on every write. */
export const OPEN_VSX_CACHE_MAX_ROWS = 500

/**
 * Maximum serialised `payload` size per row. A generous `/query` entry is a few
 * KB; 64 KB leaves headroom for long descriptions and tag lists while keeping
 * the worst case (500 rows) bounded at ~32 MB.
 */
export const OPEN_VSX_CACHE_MAX_PAYLOAD_BYTES = 64 * 1024

/** Whether a row has aged out. Exported so callers can render "stale" states. */
export function isStale(
  row: Pick<OpenVsxCacheRow, "fetchedAt">,
  ttlMs: number = OPEN_VSX_CACHE_TTL_MS,
  now: number = Date.now()
): boolean {
  return now - row.fetchedAt > ttlMs
}

/** Serialised size of a payload, or `null` if it isn't JSON-serialisable. */
function payloadSize(payload: unknown): number | null {
  try {
    const encoded = JSON.stringify(payload)
    // `undefined` payloads stringify to `undefined` (not a string).
    return typeof encoded === "string" ? encoded.length : 0
  } catch {
    // Cyclic or otherwise unserialisable — Dexie's structured clone would
    // throw on write, so treat it as uncacheable rather than blowing up.
    return null
  }
}

/** Whether a row is small enough to persist. */
function isCacheable(row: OpenVsxCacheRow): boolean {
  const size = payloadSize(row.payload)
  return size !== null && size <= OPEN_VSX_CACHE_MAX_PAYLOAD_BYTES
}

/**
 * Read one cached row.
 *
 * Returns `undefined` for a stale row — expiry is the point of the TTL, and a
 * caller that forgot to check `isStale` would otherwise render day-old data as
 * current. Stale rows are removed by `pruneStale`, not on read, so reads stay
 * side-effect free.
 */
export async function getCached(
  extensionId: string,
  ttlMs: number = OPEN_VSX_CACHE_TTL_MS
): Promise<OpenVsxCacheRow | undefined> {
  const row = await getDb().openVsxCache.get(extensionId)
  if (!row) return undefined
  return isStale(row, ttlMs) ? undefined : row
}

/**
 * Persist rows and enforce the cap, transactionally.
 *
 * Oversized rows are dropped silently — this is an optimisation cache, and a
 * skipped row costs one extra request later.
 */
export async function putCached(rows: OpenVsxCacheRow[]): Promise<void> {
  const cacheable = rows.filter(isCacheable)
  if (cacheable.length === 0) return

  const db = getDb()
  await db.transaction("rw", db.openVsxCache, async () => {
    await db.openVsxCache.bulkPut(cacheable)
    await evictBeyondCap(OPEN_VSX_CACHE_MAX_ROWS)
  })
}

/** Delete rows whose `fetchedAt` has aged past `ttlMs`. Returns the count. */
export async function pruneStale(
  ttlMs: number = OPEN_VSX_CACHE_TTL_MS,
  now: number = Date.now()
): Promise<number> {
  return getDb()
    .openVsxCache.where("fetchedAt")
    .below(now - ttlMs)
    .delete()
}

/** Trim to the newest `keep` rows by `fetchedAt`. Caller supplies the txn. */
async function evictBeyondCap(keep: number): Promise<void> {
  const db = getDb()
  const total = await db.openVsxCache.count()
  if (total <= keep) return
  const oldest = await db.openVsxCache
    .orderBy("fetchedAt")
    .limit(total - keep)
    .primaryKeys()
  if (oldest.length > 0) await db.openVsxCache.bulkDelete(oldest as string[])
}

/**
 * Build a cache row from a **search** result.
 *
 * `categories: []` is not an oversight: the live `/api/-/search` response has
 * **no `categories` field at all** (verified by curl — search entries carry
 * exactly `url, files, name, namespace, version, timestamp, verified,
 * averageRating, reviewCount, downloadCount, displayName, description,
 * deprecated`). Categories exist only on `/query`. Writing `[]` records "we
 * don't know" rather than "this extension has no categories"; a later
 * `/query` for the same extension overwrites the row with the real list.
 */
export function cacheRowFromSearchEntry(
  entry: OpenVsxSearchEntry,
  fetchedAt: number = Date.now()
): OpenVsxCacheRow {
  return {
    extensionId: `${entry.namespace}.${entry.name}`,
    fetchedAt,
    displayName: entry.displayName ?? entry.name,
    latestVersion: entry.version,
    iconUrl: entry.files.icon,
    categories: [],
    downloadCount: entry.downloadCount ?? 0,
    averageRating: entry.averageRating,
    verified: entry.verified === true,
    payload: entry,
  }
}

/** Build a cache row from a `/query` result, which does carry `categories`. */
export function cacheRowFromQueryEntry(
  entry: OpenVsxQueryEntry,
  fetchedAt: number = Date.now()
): OpenVsxCacheRow {
  return {
    extensionId: `${entry.namespace}.${entry.name}`,
    fetchedAt,
    displayName: entry.displayName ?? entry.name,
    latestVersion: entry.version,
    iconUrl: entry.files.icon,
    categories: entry.categories ?? [],
    downloadCount: entry.downloadCount ?? 0,
    averageRating: entry.averageRating,
    verified: entry.verified === true,
    payload: entry,
  }
}
