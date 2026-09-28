/**
 * Files page item metadata (ADR-0200): favorites, folder membership, "last
 * opened from Files", "removed from Files", and the keep pins that let a kept
 * item outlive its source conversation.
 *
 * `libraryItems` is authoritative; the `library:` ref rows in
 * `messageMediaRefs` are derived from it. Every write that can change whether
 * an item is kept updates both in ONE transaction, and `reconcileLibraryPins`
 * rebuilds the pins from the rows (after a backup restore, or as self-repair).
 */

import {
  collectUnreferencedMessageMedia,
  LIBRARY_OWNER_PREFIX,
  LIBRARY_REF_SESSION_ID,
} from "./message-media-refs"
import type { MessageMediaRefRow } from "./message-media-refs"
import { getDb } from "./schema"
import {
  isLibraryItemKept,
  libraryItemKey,
  ROOT_LIBRARY_FOLDER_ID,
  type LibraryItemKind,
  type LibraryItemRow,
  type LibraryItemSnapshot,
} from "./files-library-types"

type Db = ReturnType<typeof getDb>

export class LibraryItemError extends Error {
  constructor(
    readonly code:
      | "library_item_not_found"
      | "library_item_source_missing"
      | "library_item_owned"
      | "library_item_not_owned"
  ) {
    super(code)
    this.name = "LibraryItemError"
  }
}

/** Identity plus the context captured whenever Files writes an item row. */
export interface LibraryItemSource {
  kind: LibraryItemKind
  sourceId: string
  originSessionId?: string
  projectId?: string
  /** `messageMedia` key to pin while kept (images and uploads only). */
  mediaHash?: string
  snapshot?: LibraryItemSnapshot
}

/** `messageMediaRefs.messageId` of an item's pin / Files-owned source row. */
export function libraryPinOwner(key: string): string {
  return `${LIBRARY_OWNER_PREFIX}${key}`
}

function compact(row: LibraryItemRow): LibraryItemRow {
  const out = { ...row } as Record<string, unknown>
  for (const [field, value] of Object.entries(out)) if (value === undefined) delete out[field]
  return out as unknown as LibraryItemRow
}

/**
 * Make the pin rows of `row` match its keep state. Returns the hashes whose
 * pin was dropped so the caller can collect them after the transaction.
 * A Files-owned upload's owner row carries `sessionAsset`; it is the source,
 * so it is never replaced here — only removed when the row stops being kept.
 */
async function syncPin(db: Db, row: LibraryItemRow): Promise<string[]> {
  const owner = libraryPinOwner(row.key)
  const existing = await db.messageMediaRefs.where("messageId").equals(owner).toArray()
  const released: string[] = []
  if (isLibraryItemKept(row) && row.mediaHash) {
    const stale = existing.filter((ref) => ref.hash !== row.mediaHash)
    const held = existing.some((ref) => ref.hash === row.mediaHash)
    if (!held) {
      if (!(await db.messageMedia.where("hash").equals(row.mediaHash).count())) {
        throw new LibraryItemError("library_item_source_missing")
      }
      await db.messageMediaRefs.put({
        messageId: owner,
        sessionId: LIBRARY_REF_SESSION_ID,
        hash: row.mediaHash,
      })
    }
    for (const ref of stale) {
      await db.messageMediaRefs.delete([ref.messageId, ref.hash])
      released.push(ref.hash)
    }
    return released
  }
  for (const ref of existing) {
    await db.messageMediaRefs.delete([ref.messageId, ref.hash])
    released.push(ref.hash)
  }
  return released
}

async function mutateItem(
  source: LibraryItemSource,
  mutate: (row: LibraryItemRow, now: number) => LibraryItemRow
): Promise<LibraryItemRow> {
  const db = getDb()
  let released: string[] = []
  const result = await db.transaction(
    "rw",
    db.libraryItems,
    db.messageMediaRefs,
    db.messageMedia,
    async () => {
      const key = libraryItemKey(source.kind, source.sourceId)
      const now = Date.now()
      const existing = await db.libraryItems.get(key)
      const base: LibraryItemRow = existing ?? {
        key,
        kind: source.kind,
        sourceId: source.sourceId,
        createdAt: now,
        updatedAt: now,
      }
      const merged: LibraryItemRow = {
        ...base,
        originSessionId: source.originSessionId ?? base.originSessionId,
        projectId: source.projectId ?? base.projectId,
        mediaHash: source.mediaHash ?? base.mediaHash,
        snapshot: source.snapshot ?? base.snapshot,
      }
      const wasKept = existing ? isLibraryItemKept(existing) : false
      const next = mutate(merged, now)
      next.updatedAt = now
      if (isLibraryItemKept(next)) next.keptAt = wasKept ? (next.keptAt ?? now) : now
      else next.keptAt = undefined
      released = await syncPin(db, next)
      const stored = compact(next)
      await db.libraryItems.put(stored)
      return stored
    }
  )
  if (released.length > 0) await collectUnreferencedMessageMedia(released)
  return result
}

export async function getLibraryItem(key: string): Promise<LibraryItemRow | undefined> {
  return getDb().libraryItems.get(key)
}

/** Every item row. The table only holds items the user touched from Files. */
export async function listLibraryItems(): Promise<LibraryItemRow[]> {
  return getDb().libraryItems.toArray()
}

/** Record an open / preview / use from Files (drives the Recent tab). */
export async function touchLibraryItemOpened(source: LibraryItemSource): Promise<LibraryItemRow> {
  return mutateItem(source, (row, now) => ({ ...row, lastOpenedAt: now }))
}

/** Favoriting also brings a removed item back. */
export async function setLibraryItemFavorite(
  source: LibraryItemSource,
  favorite: boolean
): Promise<LibraryItemRow> {
  return mutateItem(source, (row, now) => ({
    ...row,
    favoritedAt: favorite ? (row.favoritedAt ?? now) : undefined,
    hiddenAt: favorite ? undefined : row.hiddenAt,
  }))
}

/** `null` takes the item out of the Folders tab; filing also brings a removed item back. */
export async function setLibraryItemFolder(
  source: LibraryItemSource,
  folderId: string | null
): Promise<LibraryItemRow> {
  if (folderId !== null && folderId !== ROOT_LIBRARY_FOLDER_ID) {
    if (!(await getDb().libraryFolders.get(folderId))) {
      throw new LibraryItemError("library_item_not_found")
    }
  }
  return mutateItem(source, (row) => ({
    ...row,
    folderId: folderId ?? undefined,
    hiddenAt: folderId === null ? row.hiddenAt : undefined,
  }))
}

/**
 * Adopt an item as uploaded straight into Files (an image ingested from the
 * Files "New → Upload" menu). Owned items are always kept and are deleted,
 * not hidden.
 */
export async function markLibraryItemOwned(source: LibraryItemSource): Promise<LibraryItemRow> {
  return mutateItem(source, (row, now) => ({
    ...row,
    ownedByFiles: true,
    hiddenAt: undefined,
    lastOpenedAt: now,
  }))
}

/**
 * "Remove from Files" for an item that lives in a conversation: drop the
 * favorite and the folder (so the pin goes), and hide it. The source itself is
 * untouched. A Files-owned item is deleted instead — see `deleteOwnedLibraryItem`.
 */
export async function hideLibraryItem(source: LibraryItemSource): Promise<LibraryItemRow> {
  const existing = await getLibraryItem(libraryItemKey(source.kind, source.sourceId))
  if (existing?.ownedByFiles) throw new LibraryItemError("library_item_owned")
  return mutateItem(source, (row, now) => ({
    ...row,
    favoritedAt: undefined,
    folderId: undefined,
    hiddenAt: now,
  }))
}

/**
 * Delete an item uploaded straight into Files, bytes included (unless another
 * owner — a conversation that used it — still references them).
 */
export async function deleteOwnedLibraryItem(key: string): Promise<void> {
  const db = getDb()
  const released = await db.transaction("rw", db.libraryItems, db.messageMediaRefs, async () => {
    const row = await db.libraryItems.get(key)
    if (!row) return []
    if (!row.ownedByFiles) throw new LibraryItemError("library_item_not_owned")
    const refs = await db.messageMediaRefs.where("messageId").equals(libraryPinOwner(key)).toArray()
    for (const ref of refs) await db.messageMediaRefs.delete([ref.messageId, ref.hash])
    await db.libraryItems.delete(key)
    return refs.map((ref) => ref.hash)
  })
  if (released.length > 0) await collectUnreferencedMessageMedia(released, { graceMs: 0 })
}

/** Artifact / canvas ids of `sessionId` that the session purge must spare. */
export async function listKeptSourceIdsForSession(
  sessionId: string
): Promise<{ artifactIds: Set<string>; canvasIds: Set<string> }> {
  const rows = await getDb().libraryItems.where("originSessionId").equals(sessionId).toArray()
  const artifactIds = new Set<string>()
  const canvasIds = new Set<string>()
  for (const row of rows) {
    if (!isLibraryItemKept(row)) continue
    if (row.kind === "artifact") artifactIds.add(row.sourceId)
    else if (row.kind === "canvas") canvasIds.add(row.sourceId)
  }
  return { artifactIds, canvasIds }
}

/**
 * Rebuild the `library:` pins from `libraryItems`: add a missing pin whose
 * bytes are still held, drop a pin no kept row wants. A Files-owned upload's
 * owner row is kept while its item row exists.
 */
export async function reconcileLibraryPins(): Promise<{ added: number; removed: number }> {
  const db = getDb()
  const outcome = await db.transaction(
    "rw",
    db.libraryItems,
    db.messageMediaRefs,
    db.messageMedia,
    async () => {
      const rows = await db.libraryItems.toArray()
      const byOwner = new Map(rows.map((row) => [libraryPinOwner(row.key), row]))
      const refs = await db.messageMediaRefs
        .where("messageId")
        .startsWith(LIBRARY_OWNER_PREFIX)
        .toArray()
      const released: string[] = []
      const held = new Set<string>()
      for (const ref of refs) {
        const row = byOwner.get(ref.messageId)
        const wanted =
          row !== undefined &&
          (ref.sessionAsset !== undefined
            ? row.ownedByFiles === true
            : isLibraryItemKept(row) && row.mediaHash === ref.hash)
        if (wanted) {
          held.add(ref.messageId)
          continue
        }
        await db.messageMediaRefs.delete([ref.messageId, ref.hash])
        released.push(ref.hash)
      }
      let added = 0
      for (const row of rows) {
        const owner = libraryPinOwner(row.key)
        if (held.has(owner) || !isLibraryItemKept(row) || !row.mediaHash) continue
        if (!(await db.messageMedia.where("hash").equals(row.mediaHash).count())) continue
        await db.messageMediaRefs.put({
          messageId: owner,
          sessionId: LIBRARY_REF_SESSION_ID,
          hash: row.mediaHash,
        } satisfies MessageMediaRefRow)
        added += 1
      }
      return { added, released }
    }
  )
  if (outcome.released.length > 0) await collectUnreferencedMessageMedia(outcome.released)
  return { added: outcome.added, removed: outcome.released.length }
}

/**
 * Project "delete data" cascade: the project's Files items, pins and
 * Files-owned bytes go. `sessionIds` also catches items kept from one of the
 * project's conversations before a project id was stamped on them.
 */
export async function deleteLibraryItemsForProject(
  projectId: string,
  sessionIds: readonly string[] = []
): Promise<number> {
  const db = getDb()
  const outcome = await db.transaction("rw", db.libraryItems, db.messageMediaRefs, async () => {
    const byKey = new Map<string, LibraryItemRow>()
    for (const row of await db.libraryItems.where("projectId").equals(projectId).toArray()) {
      byKey.set(row.key, row)
    }
    if (sessionIds.length > 0) {
      const fromSessions = await db.libraryItems
        .where("originSessionId")
        .anyOf([...sessionIds])
        .toArray()
      for (const row of fromSessions) byKey.set(row.key, row)
    }
    const rows = [...byKey.values()]
    const owners = rows.map((row) => libraryPinOwner(row.key))
    const refs = owners.length
      ? await db.messageMediaRefs.where("messageId").anyOf(owners).toArray()
      : []
    for (const ref of refs) await db.messageMediaRefs.delete([ref.messageId, ref.hash])
    await db.libraryItems.bulkDelete(rows.map((row) => row.key))
    return { count: rows.length, released: refs.map((ref) => ref.hash) }
  })
  if (outcome.released.length > 0) {
    await collectUnreferencedMessageMedia(outcome.released, { graceMs: 0 })
  }
  return outcome.count
}

/** Full wipe ("clear all data"): both Files tables and every `library:` ref row. */
export async function clearLibraryData(): Promise<void> {
  const db = getDb()
  const released = await db.transaction(
    "rw",
    db.libraryItems,
    db.libraryFolders,
    db.messageMediaRefs,
    async () => {
      const refs = await db.messageMediaRefs
        .where("messageId")
        .startsWith(LIBRARY_OWNER_PREFIX)
        .toArray()
      for (const ref of refs) await db.messageMediaRefs.delete([ref.messageId, ref.hash])
      await db.libraryItems.clear()
      await db.libraryFolders.clear()
      return refs.map((ref) => ref.hash)
    }
  )
  if (released.length > 0) await collectUnreferencedMessageMedia(released, { graceMs: 0 })
}
