/**
 * Read side of the content-addressed chat-media store: turns a
 * `cognia-media:<hash>` reference into a URL an `<img>` can use.
 *
 * Why this is not an `LruCache`. Two constraints are inseparable here and
 * neither is expressible with a plain size-bounded cache:
 *
 *   - **An object URL must be revoked.** Dropping the entry without calling
 *     `revokeObjectURL` pins the blob for the lifetime of the document, which
 *     is precisely the leak this whole subsystem exists to avoid.
 *   - **An entry with live holders must never be evicted.** Revoking a URL an
 *     `<img>` is still pointing at blanks the image on screen.
 *
 * So the registry refcounts. A reference with holders is untouchable; once the
 * last holder releases, the entry becomes *idle* — kept, because scrolling back
 * to a row should not re-read IndexedDB, but now eligible for eviction. Idle
 * entries are bounded by BYTES rather than count: chat images differ by orders
 * of magnitude in size, and a count-based bound would either hold hundreds of
 * megabytes of screenshots or evict thumbnails pointlessly.
 */

import {
  getMessageMedia,
  parseMediaRef,
  putMessageMedia,
  type MessageMediaRow,
} from "@/lib/db/message-media"

/**
 * Bytes of idle (no longer displayed) media kept resolved before the oldest is
 * revoked. Roughly thirty canonical 1568px frames — enough that scrolling back
 * over a recent stretch of conversation never re-reads the database, far below
 * the point where held blobs matter.
 */
export const IDLE_BYTE_BUDGET = 48 * 1024 * 1024

export interface ResolvedMedia {
  /** Object URL, valid until the last holder releases and it is evicted. */
  url: string
  mediaType: string
  width: number
  height: number
  byteSize: number
  /** True when the URL points at the thumbnail rather than the canonical frame. */
  isThumbnail: boolean
}

interface Entry extends ResolvedMedia {
  holders: number
  touchedAt: number
}

const entries = new Map<string, Entry>()
const inflight = new Map<string, Promise<ResolvedMedia | null>>()
let idleBytes = 0
let clock = 0

/** Cache key — a thumbnail and its canonical frame are separate resolutions. */
function cacheKey(hash: string, thumbnail: boolean): string {
  return `${hash}|${thumbnail ? "t" : "c"}`
}

export interface AcquireOptions {
  /**
   * Prefer the stored thumbnail. Falls back to the canonical frame when the
   * image was small enough that no thumbnail was made — callers get a URL
   * either way and can tell which from `isThumbnail`.
   */
  thumbnail?: boolean
  /**
   * Optional session-scoped fallback used by remote transcript surfaces. It
   * runs only after the local media store misses, so cached blobs remain fully
   * offline-capable and no network request is made for already-ingested media.
   */
  loadMissing?: MissingMediaLoader
}

export interface MissingMediaRequest {
  hash: string
  variant: "thumbnail" | "canonical"
}

export type MissingMediaLoader = (request: MissingMediaRequest) => Promise<MessageMediaRow | null>

/**
 * Resolve `ref` and register a holder. Every successful call must be paired
 * with `releaseMedia`, or the entry is pinned forever.
 *
 * Returns null when the reference resolves to nothing — a dangling ref after a
 * failed migration or a manual database edit. Callers render their
 * broken-image affordance rather than an empty box.
 */
export async function acquireMedia(
  ref: string,
  { thumbnail = false, loadMissing }: AcquireOptions = {}
): Promise<ResolvedMedia | null> {
  const hash = parseMediaRef(ref)
  if (!hash) return null
  const key = cacheKey(hash, thumbnail)

  const existing = entries.get(key)
  if (existing) {
    if (existing.holders === 0) idleBytes -= existing.byteSize
    existing.holders += 1
    existing.touchedAt = clock++
    return snapshot(existing)
  }

  // Two rows scrolling in together must not both read and both mint a URL.
  const pending = inflight.get(key)
  if (pending) {
    const resolved = await pending
    if (!resolved) return null
    const entry = entries.get(key)
    if (!entry) return null
    if (entry.holders === 0) idleBytes -= entry.byteSize
    entry.holders += 1
    entry.touchedAt = clock++
    return snapshot(entry)
  }

  const task = (async (): Promise<ResolvedMedia | null> => {
    try {
      let row = await getMessageMedia(hash)
      const needsRemoteVariant = !row || (!thumbnail && row.canonicalAvailable === false)
      if (needsRemoteVariant && loadMissing) {
        row =
          (await loadMissing({ hash, variant: thumbnail ? "thumbnail" : "canonical" })) ?? undefined
        if (row && row.hash !== hash) return null
        if (row) {
          // Rendering should still succeed if a quota/transient IndexedDB
          // failure prevents the offline cache write.
          try {
            await putMessageMedia(row)
          } catch {
            // Best-effort cache; the in-memory row below remains usable.
          }
        }
      }
      if (!row) return null
      const useThumb = thumbnail && row.thumbBlob !== undefined
      const blob = useThumb ? row.thumbBlob! : row.blob
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null
      const entry: Entry = {
        url: URL.createObjectURL(blob),
        mediaType: row.mediaType,
        width: useThumb ? (row.thumbWidth ?? row.width) : row.width,
        height: useThumb ? (row.thumbHeight ?? row.height) : row.height,
        byteSize: useThumb ? blob.size : row.byteSize,
        isThumbnail: useThumb,
        holders: 1,
        touchedAt: clock++,
      }
      entries.set(key, entry)
      return snapshot(entry)
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

/**
 * Drop a holder. The URL stays valid while other holders remain, and stays
 * resolved (but evictable) once the last one leaves.
 */
export function releaseMedia(ref: string, { thumbnail = false }: AcquireOptions = {}): void {
  const hash = parseMediaRef(ref)
  if (!hash) return
  const key = cacheKey(hash, thumbnail)
  const entry = entries.get(key)
  if (!entry || entry.holders === 0) return

  entry.holders -= 1
  if (entry.holders > 0) return
  entry.touchedAt = clock++
  idleBytes += entry.byteSize
  evictIdle()
}

/** Revoke least-recently-idle entries until the idle budget is respected. */
function evictIdle(): void {
  if (idleBytes <= IDLE_BYTE_BUDGET) return
  const idle = [...entries.entries()]
    .filter(([, entry]) => entry.holders === 0)
    .sort((a, b) => a[1].touchedAt - b[1].touchedAt)

  for (const [key, entry] of idle) {
    if (idleBytes <= IDLE_BYTE_BUDGET) break
    URL.revokeObjectURL(entry.url)
    entries.delete(key)
    idleBytes -= entry.byteSize
  }
}

/**
 * Revoke everything, holders included. For a hard teardown (sign-out, account
 * switch, database reset) where the documents pointing at these URLs are going
 * away too.
 */
export function releaseAllMedia(): void {
  for (const entry of entries.values()) {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(entry.url)
    }
  }
  entries.clear()
  inflight.clear()
  idleBytes = 0
}

function snapshot(entry: Entry): ResolvedMedia {
  return {
    url: entry.url,
    mediaType: entry.mediaType,
    width: entry.width,
    height: entry.height,
    byteSize: entry.byteSize,
    isThumbnail: entry.isThumbnail,
  }
}

/** Test/diagnostic view of the registry. */
export const __TESTING__ = {
  stats: () => ({
    entries: entries.size,
    idleBytes,
    holders: [...entries.values()].reduce((sum, entry) => sum + entry.holders, 0),
  }),
  reset: releaseAllMedia,
}
