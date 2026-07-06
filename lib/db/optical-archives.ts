// Optical-compaction archive store (ADR-0063). When the "optical" strategy
// compacts a conversation, the sidecar emits a `compact_boundary` event whose
// metadata carries the rendered image frames + token stats; the pre-compaction
// transcript rides the same event's `pre_messages`. We persist both here so the
// user can, after a reload, re-open a boundary and see the frame(s), the
// before/after token comparison, and — on demand — the original text that was
// imaged (the in-memory undo registry is empty after a reload).
//
// Capped at the newest `ARCHIVE_CAP` rows, trimmed transactionally on write.

import { getDb } from "./schema"

const ARCHIVE_CAP = 100

export interface OpticalArchiveFrame {
  /** PNG bytes, base64 (no data: prefix). */
  base64: string
  width: number
  height: number
}

export interface OpticalArchiveRow {
  /** The `compact_boundary` event uuid — stable per boundary. */
  id: string
  sessionId: string
  /** Epoch ms the boundary was recorded. */
  createdAt: number
  strategy: string
  preTokens: number
  postTokens: number
  frameCount: number
  frames: OpticalArchiveFrame[]
  /** The resolved render shape (font/variant/cell/size/columns). */
  shape?: Record<string, unknown>
  /** Fraction of the transcript the font could render (0..1). */
  coverage?: number
  /** Round-trip word-recall from the vision read-back (0..1), when verified. */
  readability?: number
  charCount?: number
  estImageTokens?: number
  estTextTokens?: number
  /** Total PNG byte length across frames. */
  byteLength?: number
  /** The original pre-compaction transcript text that was imaged (for reveal). */
  originalText?: string
}

/** Persist (or replace) one archive row, then trim to the newest cap. */
export async function saveOpticalArchive(row: OpticalArchiveRow): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.opticalArchives, async () => {
    await db.opticalArchives.put(row)
    await pruneOldest(ARCHIVE_CAP)
  })
}

/** Newest-first archives, optionally scoped to one session. */
export async function listOpticalArchives(filter?: {
  sessionId?: string
  limit?: number
}): Promise<OpticalArchiveRow[]> {
  const db = getDb()
  let rows: OpticalArchiveRow[]
  if (filter?.sessionId) {
    rows = await db.opticalArchives.where("sessionId").equals(filter.sessionId).sortBy("createdAt")
    rows.reverse()
  } else {
    rows = await db.opticalArchives.orderBy("createdAt").reverse().toArray()
  }
  if (filter?.limit && filter.limit > 0) rows = rows.slice(0, filter.limit)
  return rows
}

export async function getOpticalArchive(id: string): Promise<OpticalArchiveRow | undefined> {
  return getDb().opticalArchives.get(id)
}

export async function deleteOpticalArchive(id: string): Promise<void> {
  await getDb().opticalArchives.delete(id)
}

/** Clear all archives, or just one session's when `sessionId` is given. */
export async function clearOpticalArchives(sessionId?: string): Promise<void> {
  const db = getDb()
  if (sessionId) {
    await db.opticalArchives.where("sessionId").equals(sessionId).delete()
  } else {
    await db.opticalArchives.clear()
  }
}

/** Prune to the newest `keep` rows. Runs inside the caller's transaction. */
async function pruneOldest(keep: number): Promise<void> {
  const db = getDb()
  const total = await db.opticalArchives.count()
  if (total <= keep) return
  const oldest = await db.opticalArchives
    .orderBy("createdAt")
    .limit(total - keep)
    .primaryKeys()
  if (oldest.length > 0) await db.opticalArchives.bulkDelete(oldest as string[])
}

export const __TESTING__ = { ARCHIVE_CAP, pruneOldest }
