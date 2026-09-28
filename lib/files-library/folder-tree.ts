/**
 * Pure folder-tree helpers over an in-memory folder list (ADR-0200). The
 * Files page already holds every folder (a user-scale list), so breadcrumbs
 * and child lists are derived here instead of walking Dexie per render.
 */

import { ROOT_LIBRARY_FOLDER_ID, type LibraryFolder } from "@/lib/db/files-library-types"

/** Guard against a corrupt parent cycle. */
const MAX_DEPTH = 64

/** Ancestors of `folderId` from the top down, ending with the folder itself. */
export function libraryFolderPath(
  folders: readonly LibraryFolder[],
  folderId: string
): LibraryFolder[] {
  if (folderId === ROOT_LIBRARY_FOLDER_ID) return []
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const chain: LibraryFolder[] = []
  let cursor: string | undefined = folderId
  let depth = 0
  while (cursor && cursor !== ROOT_LIBRARY_FOLDER_ID && depth < MAX_DEPTH) {
    const folder = byId.get(cursor)
    if (!folder) break
    chain.unshift(folder)
    cursor = folder.parentFolderId
    depth += 1
  }
  return chain
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Direct children of `parentId`, by name. */
export function childLibraryFolders(
  folders: readonly LibraryFolder[],
  parentId: string
): LibraryFolder[] {
  return folders
    .filter((folder) => folder.parentFolderId === parentId)
    .sort((a, b) => collator.compare(a.name, b.name))
}

export interface FlatLibraryFolder {
  folder: LibraryFolder
  depth: number
}

/** Depth-first flattening for the move-to-folder picker. */
export function flattenLibraryFolders(folders: readonly LibraryFolder[]): FlatLibraryFolder[] {
  const out: FlatLibraryFolder[] = []
  const seen = new Set<string>()
  const walk = (parentId: string, depth: number) => {
    if (depth >= MAX_DEPTH) return
    for (const folder of childLibraryFolders(folders, parentId)) {
      if (seen.has(folder.id)) continue
      seen.add(folder.id)
      out.push({ folder, depth })
      walk(folder.id, depth + 1)
    }
  }
  walk(ROOT_LIBRARY_FOLDER_ID, 0)
  return out
}
