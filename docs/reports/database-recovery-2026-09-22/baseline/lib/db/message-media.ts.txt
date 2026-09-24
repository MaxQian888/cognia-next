/**
 * Content-addressed store for images carried by chat messages (Dexie v128).
 *
 * Chat images used to ride as base64 `data:` URLs inlined into
 * `messages.parts`. That put the same bytes in four places at once — the Dexie
 * row, the Zustand store, the DOM attribute and the decoded bitmap — and
 * virtualization can only reclaim the last two. A session of agent screenshots
 * measured 717MB of base64 against 2.2GB of renderer heap.
 *
 * Here the bytes live as Blobs, which IndexedDB keeps out-of-line, and a
 * message carries only `{ ref, mediaType, width, height, byteSize }`. Loading a
 * session no longer deserializes a single image.
 *
 * Keyed by content hash, so one screenshot referenced from twenty turns is
 * stored once — agent transcripts repeat frames constantly.
 */

import { getDb } from "./schema"

/** Prefix that marks a media reference inside a message part. */
export const MEDIA_REF_PREFIX = "cognia-media:"

export interface MessageMediaRow {
  /** SHA-256 of the canonical bytes, hex. The content address. */
  hash: string
  mediaType: string
  width: number
  height: number
  /** Canonical bytes: what renders inline and what the model is sent. */
  blob: Blob
  byteSize: number
  /** False only for a remote thumbnail cached before its canonical variant. */
  canonicalAvailable?: boolean
  /** Small preview for galleries and for holding space while the canonical decodes. */
  thumbBlob?: Blob
  thumbWidth?: number
  thumbHeight?: number
  /**
   * The user's original upload, kept only so "download" returns what they
   * gave us. Never rendered, never sent to a model. Absent for agent
   * screenshots, which have no original worth keeping.
   */
  originalBlob?: Blob
  originalByteSize?: number
  originalMediaType?: string
  createdAt: number
  /** Touched on read; orphan collection uses it to avoid evicting live media. */
  lastUsedAt: number
}

/** `cognia-media:<hash>` for a hash, the canonical reference form. */
export function mediaRef(hash: string): string {
  return `${MEDIA_REF_PREFIX}${hash}`
}

/** The hash inside a `cognia-media:` reference, or null for anything else. */
export function parseMediaRef(value: string | undefined | null): string | null {
  if (!value || !value.startsWith(MEDIA_REF_PREFIX)) return null
  const hash = value.slice(MEDIA_REF_PREFIX.length)
  return hash.length > 0 ? hash : null
}

export function isMediaRef(value: string | undefined | null): boolean {
  return parseMediaRef(value) !== null
}

/**
 * Insert `row` unless its hash is already stored.
 *
 * Deliberately not a `put`: re-storing an identical hash would rewrite
 * megabytes of Blob for no reason, and would clobber an `originalBlob` that an
 * earlier upload contributed and a later agent screenshot of the same frame
 * knows nothing about. Returns the reference either way.
 */
export async function putMessageMedia(row: MessageMediaRow): Promise<string> {
  const db = getDb()
  await db.transaction("rw", db.messageMedia, async () => {
    const existing = await db.messageMedia.get(row.hash)
    if (existing) {
      if (existing.canonicalAvailable === false && row.canonicalAvailable !== false) {
        await db.messageMedia.update(row.hash, {
          mediaType: row.mediaType,
          width: row.width,
          height: row.height,
          blob: row.blob,
          byteSize: row.byteSize,
          canonicalAvailable: true,
          lastUsedAt: row.lastUsedAt,
        })
      } else if (row.canonicalAvailable === false && existing.thumbBlob === undefined) {
        await db.messageMedia.update(row.hash, {
          thumbBlob: row.thumbBlob ?? row.blob,
          thumbWidth: row.thumbWidth ?? row.width,
          thumbHeight: row.thumbHeight ?? row.height,
          lastUsedAt: row.lastUsedAt,
        })
      } else {
        await db.messageMedia.update(row.hash, { lastUsedAt: row.lastUsedAt })
      }
      return
    }
    await db.messageMedia.add(row)
  })
  return mediaRef(row.hash)
}

/** Row for a hash or `cognia-media:` reference, touching `lastUsedAt`. */
export async function getMessageMedia(refOrHash: string): Promise<MessageMediaRow | undefined> {
  const hash = parseMediaRef(refOrHash) ?? refOrHash
  const db = getDb()
  const row = await db.messageMedia.get(hash)
  if (!row) return undefined
  // Best-effort: a read must not fail because the touch did.
  try {
    await db.messageMedia.update(hash, { lastUsedAt: Date.now() })
  } catch {
    // Ignore — `lastUsedAt` only informs eviction.
  }
  return row
}

/** Rows for several references in one pass. Missing hashes are skipped. */
export async function getManyMessageMedia(refsOrHashes: string[]): Promise<MessageMediaRow[]> {
  const hashes = refsOrHashes.map((value) => parseMediaRef(value) ?? value)
  if (hashes.length === 0) return []
  const rows = await getDb().messageMedia.bulkGet(hashes)
  return rows.filter((row): row is MessageMediaRow => row !== undefined)
}

/** True when the hash is already stored — lets ingest skip re-encoding. */
export async function hasMessageMedia(refOrHash: string): Promise<boolean> {
  const hash = parseMediaRef(refOrHash) ?? refOrHash
  return (await getDb().messageMedia.where("hash").equals(hash).count()) > 0
}

export async function deleteMessageMedia(refOrHash: string): Promise<void> {
  const hash = parseMediaRef(refOrHash) ?? refOrHash
  await getDb().messageMedia.delete(hash)
}

/** Total bytes held by the store — surfaced in storage settings. */
export async function messageMediaByteTotal(): Promise<number> {
  let total = 0
  await getDb().messageMedia.each((row) => {
    total += row.byteSize + (row.originalByteSize ?? 0)
  })
  return total
}

/**
 * Delete stored media no message references any more.
 *
 * `liveRefs` must be every reference reachable from any persisted message —
 * the caller collects it, because only it knows which sessions exist. Rows
 * newer than `graceMs` are spared regardless: an image is written to this
 * store slightly before the message that references it is persisted, and
 * collecting in that window would delete a live image.
 */
export async function collectOrphanedMedia(
  liveRefs: Iterable<string>,
  { graceMs = 60_000, now = Date.now() }: { graceMs?: number; now?: number } = {}
): Promise<number> {
  const live = new Set<string>()
  for (const ref of liveRefs) {
    const hash = parseMediaRef(ref)
    if (hash) live.add(hash)
  }

  const db = getDb()
  const doomed: string[] = []
  await db.messageMedia.each((row) => {
    if (live.has(row.hash)) return
    if (now - row.createdAt < graceMs) return
    doomed.push(row.hash)
  })
  if (doomed.length > 0) await db.messageMedia.bulkDelete(doomed)
  return doomed.length
}
