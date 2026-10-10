/**
 * Rename from Files (ADR-0223), by who owns the item:
 *
 * - a canvas document is the person's own and editable everywhere, so its
 *   title changes at the source;
 * - a Files-owned upload belongs to Files, so its filename changes at the
 *   source (what a download is called);
 * - everything else — an artifact, a conversation's image or file, an image
 *   uploaded into Files (it has no filename of its own) — keeps its source
 *   title, and Files stores a display name on its item. Renaming back to the
 *   source title clears the display name; an empty name is refused.
 */

import { setLibraryItemDisplayName, type LibraryItemSource } from "@/lib/db/files-library-items"
import { renameLibraryAsset } from "@/lib/db/session-assets"

import { entrySource, type FilesEntry } from "./types"

export type FilesRenameTarget = "canvas-title" | "library-asset" | "display-name"

export function renameTargetFor(
  entry: Pick<FilesEntry, "kind" | "ownedByFiles">
): FilesRenameTarget {
  if (entry.kind === "canvas") return "canvas-title"
  if (entry.kind === "upload" && entry.ownedByFiles) return "library-asset"
  return "display-name"
}

export class FilesRenameError extends Error {
  constructor(readonly code: "files_name_required" | "files_source_missing") {
    super(code)
    this.name = "FilesRenameError"
  }
}

export interface FilesRenameDependencies {
  renameCanvas: (id: string, title: string) => boolean
  renameAsset: (assetId: string, filename: string) => Promise<unknown>
  setDisplayName: (source: LibraryItemSource, name: string | null) => Promise<unknown>
}

async function renameCanvasInStore(id: string, title: string): Promise<boolean> {
  const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
  const store = useArtifactStore.getState()
  if (!store.canvasDocuments[id]) return false
  store.updateCanvasDocument(id, { title })
  return true
}

const DEFAULT_DEPENDENCIES: Omit<FilesRenameDependencies, "renameCanvas"> = {
  renameAsset: renameLibraryAsset,
  setDisplayName: setLibraryItemDisplayName,
}

export async function renameFilesEntry(
  entry: FilesEntry,
  name: string,
  dependencies: Partial<FilesRenameDependencies> = {}
): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new FilesRenameError("files_name_required")
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const source = entrySource(entry)
  switch (renameTargetFor(entry)) {
    case "canvas-title": {
      const renamed = deps.renameCanvas
        ? deps.renameCanvas(entry.sourceId, trimmed)
        : await renameCanvasInStore(entry.sourceId, trimmed)
      if (!renamed) throw new FilesRenameError("files_source_missing")
      // The source carries the name now; an older display name would hide it.
      if (entry.title !== entry.sourceTitle) await deps.setDisplayName(source, null)
      return
    }
    case "library-asset":
      await deps.renameAsset(entry.sourceId, trimmed)
      if (entry.title !== entry.sourceTitle) await deps.setDisplayName(source, null)
      return
    case "display-name":
      await deps.setDisplayName(source, trimmed === entry.sourceTitle ? null : trimmed)
      return
  }
}
