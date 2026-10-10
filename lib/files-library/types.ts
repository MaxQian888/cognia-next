/**
 * View model of the Files page (ADR-0200): one `FilesEntry` per card, merged
 * from artifacts, canvas documents, chat images, conversation uploads and
 * Files-owned uploads, with the Files metadata (`libraryItems`) folded in.
 */

import type {
  LibraryItemGeneratedVideo,
  LibraryItemKind,
  LibraryItemRow,
  LibraryItemWorkspaceLocation,
} from "@/lib/db/files-library-types"
import type { LibraryItemSource } from "@/lib/db/files-library-items"

/**
 * Where to look (ADR-0223): the sidebar's places. A place combines with any
 * lens; the Trash ignores lenses.
 */
export type FilesSection =
  | { kind: "all" }
  | { kind: "group"; group: FilesTypeGroup }
  | { kind: "folder"; folderId: string }
  | { kind: "recent" }
  | { kind: "trash" }

/**
 * The sidebar's type groups, by what an item is rather than its file format.
 * `workspace` holds the files agents left on disk (ADR-0223 §8), which show
 * nowhere else until the person keeps one (see `filter.ts`).
 */
export type FilesTypeGroup =
  "documents" | "artifacts" | "images" | "videos" | "uploads" | "workspace"

export const FILES_TYPE_GROUPS: readonly FilesTypeGroup[] = [
  "documents",
  "artifacts",
  "images",
  "videos",
  "uploads",
  "workspace",
]

/** How to look (ADR-0223): the row of lenses above the main area. */
export type FilesLens = "suggested" | "favorites" | "mine" | "ai" | "shared"

export const FILES_LENSES: readonly FilesLens[] = ["suggested", "favorites", "mine", "ai", "shared"]

/** Columns a list header sorts by. */
export type FilesSortKey = "name" | "source" | "activity" | "size" | "type"

export const FILES_SORT_KEYS: readonly FilesSortKey[] = [
  "name",
  "source",
  "activity",
  "size",
  "type",
]

export interface FilesSort {
  key: FilesSortKey
  dir: "asc" | "desc"
}

/** "Modified" filter: within the last day / week / month / year. */
export type FilesModifiedWithin = "any" | "day" | "week" | "month" | "year"

export const FILES_MODIFIED_WITHIN: readonly FilesModifiedWithin[] = [
  "any",
  "day",
  "week",
  "month",
  "year",
]

/** "Size" filter bands: < 1 MB, 1–10 MB, 10–100 MB, ≥ 100 MB. */
export type FilesSizeBand = "any" | "small" | "medium" | "large" | "huge"

export const FILES_SIZE_BANDS: readonly FilesSizeBand[] = [
  "any",
  "small",
  "medium",
  "large",
  "huge",
]

/** `current` = the active workspace (rows without a workspace are shared); `all` = everywhere. */
export type FilesProjectScope = "current" | "all"

/**
 * Who made an item (ADR-0223): `user` for what the person uploaded, wrote or
 * created from a menu; `ai` for what an assistant or agent produced.
 */
export type FilesCreator = "user" | "ai"

export interface FilesEntry {
  /** `libraryItemKey(kind, sourceId)`. */
  key: string
  kind: LibraryItemKind
  sourceId: string
  /**
   * The name Files shows: the item's `displayName` when it was renamed in
   * Files, else the source's title. Empty for an image with no known name;
   * the UI renders a localized label.
   */
  title: string
  /** The source's own title, whatever Files calls the item. */
  sourceTitle: string
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
  /** Title of `originSessionId` while that conversation exists. */
  originSessionTitle?: string
  /** The item's conversation is a collaboration session someone else shared. */
  sharedWithMe: boolean
  creator: FilesCreator
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
  /** "Removed from Files" (see `isItemHidden`). Never true for a trashed item. */
  hidden: boolean
  /** In the Files Trash since this time; such an item shows only in the Trash. */
  trashedAt?: number
  /** Live share links made from Files that carry the item (ADR-0223); absent = none. */
  sharedLinks?: number
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
  /** Set when the upload is a video a generation job made (ADR-0205). */
  generated?: FilesGeneratedVideo
  /** Set on a workspace file (ADR-0223 §8): where it lives on the host's disk. */
  workspace?: FilesWorkspaceFile
  /** Lower-cased haystack for search: title, media type and a bounded body excerpt. */
  searchText: string
}

/** What a generated video's job recorded about it. */
export type FilesGeneratedVideo = LibraryItemGeneratedVideo

/** Where a workspace file lives on disk, and what the agent did to it last. */
export interface FilesWorkspaceFile extends LibraryItemWorkspaceLocation {
  /**
   * `created` sticks through later edits: the agent wrote this file. Absent
   * when the card was rebuilt from a kept item after its record had gone.
   */
  change?: "created" | "modified" | "renamed"
  /** Where a renamed file was before. */
  oldPath?: string
}

/**
 * The `files.kinds.*` label of an entry: its kind, except that an upload which
 * is a video reads as a video rather than a generic file.
 */
export function entryKindLabelKey(entry: Pick<FilesEntry, "kind" | "mediaType">): string {
  return isVideoEntry(entry) ? "video" : entry.kind
}

/** An upload whose bytes are a video. */
export function isVideoEntry(entry: Pick<FilesEntry, "kind" | "mediaType">): boolean {
  return (
    (entry.kind === "session-upload" || entry.kind === "upload") &&
    typeof entry.mediaType === "string" &&
    entry.mediaType.toLowerCase().startsWith("video/")
  )
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
      title: entry.sourceTitle,
      ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
      ...(entry.byteSize !== undefined ? { byteSize: entry.byteSize } : {}),
      ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      ...(entry.excerpt ? { extractedText: entry.excerpt } : {}),
      ...(entry.generated ? { generated: entry.generated } : {}),
      ...(entry.workspace
        ? {
            workspace: {
              sessionId: entry.workspace.sessionId,
              workspaceRoot: entry.workspace.workspaceRoot,
              executionRoot: entry.workspace.executionRoot,
              relPath: entry.workspace.relPath,
            },
          }
        : {}),
    },
  }
}

export type { LibraryItemRow }
