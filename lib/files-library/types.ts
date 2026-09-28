/**
 * View model of the Files page (ADR-0200): one `FilesEntry` per card, merged
 * from artifacts, canvas documents, chat images, conversation uploads and
 * Files-owned uploads, with the Files metadata (`libraryItems`) folded in.
 */

import type { LibraryItemKind, LibraryItemRow } from "@/lib/db/files-library-types"
import type { LibraryItemSource } from "@/lib/db/files-library-items"

export type FilesTab = "recent" | "favorites" | "folders" | "images" | "all"

export const FILES_TABS: readonly FilesTab[] = ["recent", "favorites", "folders", "images", "all"]

/** Type filter; `file` covers both conversation and Files-owned uploads. */
export type FilesTypeFilter = "all" | "artifact" | "canvas" | "image" | "file"

export const FILES_TYPE_FILTERS: readonly FilesTypeFilter[] = [
  "all",
  "artifact",
  "canvas",
  "image",
  "file",
]

export type FilesSort = "recent" | "updated" | "created" | "name" | "size"

export const FILES_SORTS: readonly FilesSort[] = ["recent", "updated", "created", "name", "size"]

/** `current` = the active workspace (rows without a workspace are shared); `all` = everywhere. */
export type FilesProjectScope = "current" | "all"

export interface FilesEntry {
  /** `libraryItemKey(kind, sourceId)`. */
  key: string
  kind: LibraryItemKind
  sourceId: string
  /** Empty for an image with no known name; the UI renders a localized label. */
  title: string
  mediaType?: string
  /** Artifact type (`code`, `document`, …) or canvas type (`code` / `text`). */
  subtype?: string
  language?: string
  byteSize?: number
  /** Workspaces the item belongs to; empty = shared (shown in every workspace). */
  projectIds: string[]
  /** Live conversations that contain the item. */
  sessionIds: string[]
  /** Conversation the item was created in (artifact / canvas / kept upload). */
  originSessionId?: string
  /**
   * False when the item came from conversations that no longer exist — it is
   * still here only because Files keeps it. Always true for Files-owned items
   * and standalone canvas documents.
   */
  originAlive: boolean
  createdAt: number
  updatedAt: number
  /** Last opened in its own surface or from Files; undefined when never recorded. */
  lastAccessedAt?: number
  favoritedAt?: number
  folderId?: string
  ownedByFiles: boolean
  hidden: boolean
  /** `messageMedia` key of the bytes (images and uploads). */
  mediaHash?: string
  /** sha-256 of the original bytes (uploads). */
  contentHash?: string
  /** Asset id: Files-owned upload, or one conversation's copy of a session upload. */
  assetId?: string
  /** Conversation whose asset `assetId` names (session uploads). */
  assetSessionId?: string
  /** Bounded extracted text of an upload, copied into the snapshot when kept. */
  excerpt?: string
  /** Lower-cased haystack for search: title, media type and a bounded body excerpt. */
  searchText: string
}

/** Everything a Files write needs to know about an entry. */
export function entrySource(entry: FilesEntry): LibraryItemSource {
  return {
    kind: entry.kind,
    sourceId: entry.sourceId,
    ...(entry.originSessionId ? { originSessionId: entry.originSessionId } : {}),
    ...(entry.projectIds[0] ? { projectId: entry.projectIds[0] } : {}),
    ...(entry.mediaHash ? { mediaHash: entry.mediaHash } : {}),
    snapshot: {
      title: entry.title,
      ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
      ...(entry.byteSize !== undefined ? { byteSize: entry.byteSize } : {}),
      ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      ...(entry.excerpt ? { extractedText: entry.excerpt } : {}),
    },
  }
}

export type { LibraryItemRow }
