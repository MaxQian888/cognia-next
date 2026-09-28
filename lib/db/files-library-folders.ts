/**
 * Files page folder tree (ADR-0200). Same shape and API as the workflow
 * library folders (`lib/db/workflow-folders.ts`) so the tree UI helpers are
 * shared; the difference is what lives in a folder — `libraryItems` rows,
 * whose folder membership also decides whether the item is kept.
 *
 * Root is the sentinel `ROOT_LIBRARY_FOLDER_ID`, never `null` (IndexedDB can't
 * index null). An item filed at the root of the Folders tab carries
 * `folderId === ROOT_LIBRARY_FOLDER_ID` and stays kept.
 */

import { collectUnreferencedMessageMedia } from "./message-media-refs"
import { getDb } from "./schema"
import {
  isLibraryItemKept,
  ROOT_LIBRARY_FOLDER_ID,
  type LibraryFolder,
  type LibraryFolderPatch,
} from "./files-library-types"
import { libraryPinOwner } from "./files-library-items"

/** Guard against a corrupt `parentFolderId` cycle when walking up to root. */
const MAX_DEPTH = 64

function newFolderId(): string {
  return "lbf_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listLibraryFolders(): Promise<LibraryFolder[]> {
  return getDb().libraryFolders.orderBy("name").toArray()
}

export async function listChildLibraryFolders(parentFolderId: string): Promise<LibraryFolder[]> {
  return getDb().libraryFolders.where("parentFolderId").equals(parentFolderId).sortBy("name")
}

export async function getLibraryFolder(id: string): Promise<LibraryFolder | undefined> {
  return getDb().libraryFolders.get(id)
}

export interface LibraryFolderDraft {
  /** Already trimmed and non-empty; the caller supplies the localized fallback. */
  name: string
  parentFolderId?: string
  color?: string
  icon?: string
}

export class LibraryFolderError extends Error {
  constructor(
    readonly code:
      "library_folder_name_required" | "library_folder_parent_missing" | "library_folder_cycle"
  ) {
    super(code)
    this.name = "LibraryFolderError"
  }
}

async function assertParent(parentFolderId: string): Promise<void> {
  if (parentFolderId === ROOT_LIBRARY_FOLDER_ID) return
  if (!(await getDb().libraryFolders.get(parentFolderId))) {
    throw new LibraryFolderError("library_folder_parent_missing")
  }
}

export async function createLibraryFolder(draft: LibraryFolderDraft): Promise<LibraryFolder> {
  const name = draft.name.trim()
  if (!name) throw new LibraryFolderError("library_folder_name_required")
  const parentFolderId = draft.parentFolderId ?? ROOT_LIBRARY_FOLDER_ID
  await assertParent(parentFolderId)
  const now = Date.now()
  const folder: LibraryFolder = {
    id: newFolderId(),
    name,
    parentFolderId,
    createdAt: now,
    updatedAt: now,
    ...(draft.color ? { color: draft.color } : {}),
    ...(draft.icon ? { icon: draft.icon } : {}),
  }
  await getDb().libraryFolders.put(folder)
  return folder
}

export async function renameLibraryFolder(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new LibraryFolderError("library_folder_name_required")
  await getDb().libraryFolders.update(id, { name: trimmed, updatedAt: Date.now() })
}

export async function updateLibraryFolder(id: string, patch: LibraryFolderPatch): Promise<void> {
  await getDb().libraryFolders.update(id, { ...patch, updatedAt: Date.now() })
}

/** Re-parent a folder; refuses a move into itself or its own subtree. */
export async function moveLibraryFolder(id: string, newParentFolderId: string): Promise<void> {
  if (id === newParentFolderId) throw new LibraryFolderError("library_folder_cycle")
  if (newParentFolderId !== ROOT_LIBRARY_FOLDER_ID) {
    await assertParent(newParentFolderId)
    const descendants = await getLibraryFolderDescendantIds(id)
    if (descendants.has(newParentFolderId)) throw new LibraryFolderError("library_folder_cycle")
  }
  await getDb().libraryFolders.update(id, {
    parentFolderId: newParentFolderId,
    updatedAt: Date.now(),
  })
}

export type DeleteLibraryFolderMode = "reparent" | "cascade"

/**
 * Delete a folder. Never deletes an item.
 *   • "reparent" — child folders and items move up to the deleted folder's
 *     parent (an item that lands on the root stays filed, so stays kept).
 *   • "cascade" — the whole subtree of folders goes and its items leave the
 *     Folders tab; an item kept only by its folder loses its pin.
 * One transaction over both tables and the pin ledger.
 */
export async function deleteLibraryFolder(
  id: string,
  mode: DeleteLibraryFolderMode = "reparent"
): Promise<void> {
  const db = getDb()
  const released = await db.transaction(
    "rw",
    db.libraryFolders,
    db.libraryItems,
    db.messageMediaRefs,
    async () => {
      const folder = await db.libraryFolders.get(id)
      if (!folder) return []
      const now = Date.now()
      if (mode === "reparent") {
        const target = folder.parentFolderId
        await db.libraryFolders
          .where("parentFolderId")
          .equals(id)
          .modify({ parentFolderId: target, updatedAt: now })
        await db.libraryItems
          .where("folderId")
          .equals(id)
          .modify({ folderId: target, updatedAt: now })
        await db.libraryFolders.delete(id)
        return []
      }
      const subtree = await getLibraryFolderDescendantIds(id)
      subtree.add(id)
      const ids = [...subtree]
      const items = await db.libraryItems.where("folderId").anyOf(ids).toArray()
      const dropped: string[] = []
      for (const item of items) {
        const next = { ...item, updatedAt: now }
        delete next.folderId
        if (!isLibraryItemKept(next)) {
          delete next.keptAt
          const refs = await db.messageMediaRefs
            .where("messageId")
            .equals(libraryPinOwner(item.key))
            .toArray()
          for (const ref of refs) {
            await db.messageMediaRefs.delete([ref.messageId, ref.hash])
            dropped.push(ref.hash)
          }
        }
        await db.libraryItems.put(next)
      }
      await db.libraryFolders.bulkDelete(ids)
      return dropped
    }
  )
  if (released.length > 0) await collectUnreferencedMessageMedia(released)
}

/** Folders from the topmost ancestor down to `id`; `[]` for root or a missing folder. */
export async function getLibraryFolderPath(id: string): Promise<LibraryFolder[]> {
  if (id === ROOT_LIBRARY_FOLDER_ID) return []
  const db = getDb()
  const chain: LibraryFolder[] = []
  let cursor: string | undefined = id
  let depth = 0
  while (cursor && cursor !== ROOT_LIBRARY_FOLDER_ID && depth < MAX_DEPTH) {
    const folder: LibraryFolder | undefined = await db.libraryFolders.get(cursor)
    if (!folder) break
    chain.unshift(folder)
    cursor = folder.parentFolderId
    depth += 1
  }
  return chain
}

/** All folder ids strictly below `id`. */
export async function getLibraryFolderDescendantIds(id: string): Promise<Set<string>> {
  const db = getDb()
  const out = new Set<string>()
  let frontier = [id]
  let depth = 0
  while (frontier.length > 0 && depth < MAX_DEPTH) {
    const children = await db.libraryFolders.where("parentFolderId").anyOf(frontier).toArray()
    const next: string[] = []
    for (const child of children) {
      if (!out.has(child.id)) {
        out.add(child.id)
        next.push(child.id)
      }
    }
    frontier = next
    depth += 1
  }
  return out
}
