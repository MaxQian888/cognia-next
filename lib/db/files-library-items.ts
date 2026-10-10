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
  type LibraryItemGeneratedVideo,
  type LibraryItemKind,
  type LibraryItemRow,
  type LibraryItemSnapshot,
} from "./files-library-types"
import { generatedVideoRecord } from "./media-generation-jobs"

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

/** One item's read-modify-write inside the caller's transaction. */
async function mutateRow(
  db: Db,
  source: LibraryItemSource,
  mutate: (row: LibraryItemRow, now: number) => LibraryItemRow,
  now: number
): Promise<{ stored: LibraryItemRow; released: string[] }> {
  const key = libraryItemKey(source.kind, source.sourceId)
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
  const released = await syncPin(db, next)
  const stored = compact(next)
  await db.libraryItems.put(stored)
  return { stored, released }
}

/**
 * Apply one mutation to many items in ONE transaction, so a bulk action
 * either lands on every selected item or on none of them.
 */
async function mutateItems(
  sources: readonly LibraryItemSource[],
  mutate: (row: LibraryItemRow, now: number) => LibraryItemRow
): Promise<LibraryItemRow[]> {
  if (sources.length === 0) return []
  const db = getDb()
  const released: string[] = []
  const result = await db.transaction(
    "rw",
    db.libraryItems,
    db.messageMediaRefs,
    db.messageMedia,
    async () => {
      const now = Date.now()
      const rows: LibraryItemRow[] = []
      for (const source of sources) {
        const outcome = await mutateRow(db, source, mutate, now)
        rows.push(outcome.stored)
        released.push(...outcome.released)
      }
      return rows
    }
  )
  if (released.length > 0) await collectUnreferencedMessageMedia(released)
  return result
}

async function mutateItem(
  source: LibraryItemSource,
  mutate: (row: LibraryItemRow, now: number) => LibraryItemRow
): Promise<LibraryItemRow> {
  const [row] = await mutateItems([source], mutate)
  return row!
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

/** Favoriting also brings a removed item back. A trashed item stays in the Trash. */
export async function setLibraryItemFavorite(
  source: LibraryItemSource,
  favorite: boolean
): Promise<LibraryItemRow> {
  const [row] = await setLibraryItemsFavorite([source], favorite)
  return row!
}

/** `setLibraryItemFavorite` over a selection, in one transaction. */
export async function setLibraryItemsFavorite(
  sources: readonly LibraryItemSource[],
  favorite: boolean
): Promise<LibraryItemRow[]> {
  return mutateItems(sources, (row, now) => ({
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
  const [row] = await setLibraryItemsFolder([source], folderId)
  return row!
}

/** `setLibraryItemFolder` over a selection, in one transaction. */
export async function setLibraryItemsFolder(
  sources: readonly LibraryItemSource[],
  folderId: string | null
): Promise<LibraryItemRow[]> {
  if (folderId !== null && folderId !== ROOT_LIBRARY_FOLDER_ID) {
    if (!(await getDb().libraryFolders.get(folderId))) {
      throw new LibraryItemError("library_item_not_found")
    }
  }
  return mutateItems(sources, (row) => ({
    ...row,
    folderId: folderId ?? undefined,
    hiddenAt: folderId === null ? row.hiddenAt : undefined,
  }))
}

/**
 * Move items to the Files Trash (ADR-0223). Favorite and folder are kept so a
 * restore puts each item back where it was, and the item stays kept — its
 * bytes stay pinned — until it is restored or purged.
 */
export async function trashLibraryItems(
  sources: readonly LibraryItemSource[]
): Promise<LibraryItemRow[]> {
  return mutateItems(sources, (row, now) => ({
    ...row,
    trashedAt: row.trashedAt ?? now,
    hiddenAt: undefined,
  }))
}

/** A trashed item to restore, with whether its source conversation still exists. */
export interface LibraryItemRestoreSource extends LibraryItemSource {
  /**
   * False when nothing outside Files holds the item any more. Such an item
   * would vanish (and lose its bytes) the moment the Trash let go of it, so it
   * is filed at the root of Folders instead, where it stays kept.
   */
  originAlive: boolean
}

/** Take items out of the Trash, back to their favorite and folder. */
export async function restoreLibraryItems(
  sources: readonly LibraryItemRestoreSource[]
): Promise<LibraryItemRow[]> {
  const alive = new Map(
    sources.map((source) => [libraryItemKey(source.kind, source.sourceId), source.originAlive])
  )
  return mutateItems(sources, (row) => {
    const next: LibraryItemRow = { ...row, trashedAt: undefined }
    if (!alive.get(row.key) && !isLibraryItemKept(next)) next.folderId = ROOT_LIBRARY_FOLDER_ID
    return next
  })
}

/**
 * End a trashed item whose source still lives in a conversation: it leaves
 * the Trash as "removed from Files" (`hiddenAt`), its favorite and folder go,
 * and the source itself is untouched. The purge's answer for every kind Files
 * does not own while that source is alive.
 */
export async function retireTrashedLibraryItems(
  sources: readonly LibraryItemSource[]
): Promise<LibraryItemRow[]> {
  return mutateItems(sources, (row, now) => ({
    ...row,
    trashedAt: undefined,
    favoritedAt: undefined,
    folderId: undefined,
    hiddenAt: now,
  }))
}

/**
 * Drop item rows and their pins outright. For a trashed item nothing else
 * holds any more: once the pin goes, media GC takes bytes nobody references.
 * Never used on a Files-owned upload — `deleteOwnedLibraryItem` is its delete.
 */
export async function deleteLibraryItemRows(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  const db = getDb()
  const released = await db.transaction("rw", db.libraryItems, db.messageMediaRefs, async () => {
    const rows = (await db.libraryItems.bulkGet([...keys])).filter(
      (row): row is LibraryItemRow => row !== undefined
    )
    if (rows.some((row) => row.ownedByFiles)) throw new LibraryItemError("library_item_owned")
    const owners = rows.map((row) => libraryPinOwner(row.key))
    const refs = owners.length
      ? await db.messageMediaRefs.where("messageId").anyOf(owners).toArray()
      : []
    for (const ref of refs) await db.messageMediaRefs.delete([ref.messageId, ref.hash])
    await db.libraryItems.bulkDelete(rows.map((row) => row.key))
    return refs.map((ref) => ref.hash)
  })
  if (released.length > 0) await collectUnreferencedMessageMedia(released, { graceMs: 0 })
}

/** Trashed rows whose `trashedAt` is at or before `cutoff`, via the index. */
export async function listTrashedLibraryItemsBefore(cutoff: number): Promise<LibraryItemRow[]> {
  return getDb().libraryItems.where("trashedAt").belowOrEqual(cutoff).toArray()
}

/**
 * Show `name` in Files instead of the source's title; `null` (or a blank
 * name) goes back to the source's title. For kinds Files must not rename at
 * the source — see `LibraryItemRow.displayName`.
 */
export async function setLibraryItemDisplayName(
  source: LibraryItemSource,
  name: string | null
): Promise<LibraryItemRow> {
  const trimmed = name?.trim()
  return mutateItem(source, (row) => ({ ...row, displayName: trimmed || undefined }))
}

/**
 * Remember that a share link made from Files carries these items. Codes no
 * longer in `liveCodes` (revoked, expired or forgotten links) are dropped on
 * the way, so the list never outgrows the links that still exist. Sharing
 * does not keep an item: the share holds its own copy of the bytes.
 */
export async function recordLibraryItemsShared(
  sources: readonly LibraryItemSource[],
  code: string,
  liveCodes: ReadonlySet<string>
): Promise<LibraryItemRow[]> {
  return mutateItems(sources, (row) => {
    const kept = (row.sharedLinkCodes ?? []).filter(
      (existing) => existing !== code && liveCodes.has(existing)
    )
    return { ...row, sharedLinkCodes: [...kept, code] }
  })
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

/**
 * Before a conversation's video jobs are deleted with it (ADR-0205), copy
 * what each generated video's job recorded onto the Files items that outlive
 * the conversation with the same bytes: its kept conversation upload
 * (`session-upload:<contentHash>`) and any upload made straight into Files.
 * Otherwise such an item loses its prompt and model the moment the job row
 * goes. An item that already carries a copy (taken when it was kept) keeps it.
 *
 * Runs inside the caller's delete transaction, before the conversation's media
 * refs and jobs are removed; the transaction must include `libraryItems`,
 * `messageMediaRefs` and `mediaGenerationJobs`. Returns how many items gained
 * a copy.
 */
export async function preserveGeneratedVideoRecords(
  db: Db,
  sessionIds: readonly string[]
): Promise<number> {
  if (sessionIds.length === 0) return 0
  const jobs = await db.mediaGenerationJobs
    .where("sessionId")
    .anyOf([...sessionIds])
    .filter((row) => row.status === "succeeded" && row.result?.content.kind === "session-asset")
    .toArray()
  if (jobs.length === 0) return 0

  const assetKey = (sessionId: string, assetId: string) => `${sessionId}\u0000${assetId}`
  const hashOfAsset = new Map<string, string>()
  const refs = await db.messageMediaRefs
    .where("sessionId")
    .anyOf([...sessionIds])
    .toArray()
  for (const { sessionAsset } of refs) {
    if (sessionAsset) {
      hashOfAsset.set(
        assetKey(sessionAsset.sessionId, sessionAsset.assetId),
        sessionAsset.contentHash
      )
    }
  }
  const recordByHash = new Map<string, LibraryItemGeneratedVideo>()
  for (const job of jobs) {
    const content = job.result?.content
    if (content?.kind !== "session-asset") continue
    const hash = hashOfAsset.get(assetKey(content.sessionId, content.assetId))
    if (hash && !recordByHash.has(hash)) recordByHash.set(hash, generatedVideoRecord(job))
  }
  if (recordByHash.size === 0) return 0

  const hashOfItem = new Map<string, string>()
  for (const hash of recordByHash.keys())
    hashOfItem.set(libraryItemKey("session-upload", hash), hash)
  // A Files upload's owner ref carries its source, content hash included.
  const owners = await db.messageMediaRefs
    .where("messageId")
    .startsWith(LIBRARY_OWNER_PREFIX)
    .filter(
      (ref) => ref.sessionAsset !== undefined && recordByHash.has(ref.sessionAsset.contentHash)
    )
    .toArray()
  for (const ref of owners) {
    hashOfItem.set(ref.messageId.slice(LIBRARY_OWNER_PREFIX.length), ref.sessionAsset!.contentHash)
  }

  let preserved = 0
  for (const row of await db.libraryItems.bulkGet([...hashOfItem.keys()])) {
    if (!row?.snapshot || row.snapshot.generated) continue
    const generated = recordByHash.get(hashOfItem.get(row.key)!)!
    // Not a change the user made, so `updatedAt` stays.
    await db.libraryItems.put({ ...row, snapshot: { ...row.snapshot, generated } })
    preserved += 1
  }
  return preserved
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
