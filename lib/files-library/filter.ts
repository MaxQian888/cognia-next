/**
 * Tab / folder / type / workspace / search filtering and ordering of Files
 * entries (ADR-0200). Pure; the page applies it to the aggregated list.
 */

import { ROOT_LIBRARY_FOLDER_ID } from "@/lib/db/files-library-types"
import { entryRecency } from "./aggregate"
import type { FilesEntry, FilesProjectScope, FilesSort, FilesTab, FilesTypeFilter } from "./types"

export interface FilesQuery {
  tab: FilesTab
  /** Folder shown in the Folders tab; the root when omitted. */
  folderId?: string
  type: FilesTypeFilter
  search: string
  projectScope: FilesProjectScope
  activeProjectId?: string | null
}

export function matchesType(entry: FilesEntry, type: FilesTypeFilter): boolean {
  switch (type) {
    case "all":
      return true
    case "artifact":
      return entry.kind === "artifact"
    case "canvas":
      return entry.kind === "canvas"
    case "image":
      return entry.kind === "image"
    case "file":
      return entry.kind === "session-upload" || entry.kind === "upload"
  }
}

/** Same rule as ⌘K's `byProjectId`: a row with no workspace is shared, not foreign. */
export function matchesProject(
  entry: FilesEntry,
  scope: FilesProjectScope,
  activeProjectId: string | null | undefined
): boolean {
  if (scope === "all" || !activeProjectId) return true
  return entry.projectIds.length === 0 || entry.projectIds.includes(activeProjectId)
}

/** Every whitespace-separated term must appear (case-insensitive). */
export function matchesSearch(entry: FilesEntry, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => entry.searchText.includes(term))
}

function matchesTab(entry: FilesEntry, tab: FilesTab, folderId: string): boolean {
  switch (tab) {
    case "recent":
    case "all":
      return !entry.hidden
    case "images":
      return entry.kind === "image" && !entry.hidden
    case "favorites":
      return entry.favoritedAt !== undefined
    case "folders":
      return entry.folderId === folderId
  }
}

export function filterFilesEntries(
  entries: readonly FilesEntry[],
  query: FilesQuery
): FilesEntry[] {
  const folderId = query.folderId ?? ROOT_LIBRARY_FOLDER_ID
  return entries.filter(
    (entry) =>
      matchesTab(entry, query.tab, folderId) &&
      matchesType(entry, query.type) &&
      matchesProject(entry, query.projectScope, query.activeProjectId) &&
      matchesSearch(entry, query.search)
  )
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

function compare(sort: FilesSort): (a: FilesEntry, b: FilesEntry) => number {
  switch (sort) {
    case "recent":
      return (a, b) => entryRecency(b) - entryRecency(a)
    case "updated":
      return (a, b) => b.updatedAt - a.updatedAt
    case "created":
      return (a, b) => b.createdAt - a.createdAt
    case "name":
      // Untitled images sort after named items, newest first among themselves.
      return (a, b) =>
        a.title && b.title
          ? collator.compare(a.title, b.title)
          : a.title
            ? -1
            : b.title
              ? 1
              : b.createdAt - a.createdAt
    case "size":
      return (a, b) => (b.byteSize ?? 0) - (a.byteSize ?? 0)
  }
}

/**
 * Order entries. The Favorites tab orders by when an item was favorited; the
 * Recent tab pins favorites above everything else. Ties break on key so the
 * grid never reshuffles between renders.
 */
export function sortFilesEntries(
  entries: readonly FilesEntry[],
  sort: FilesSort,
  tab: FilesTab
): FilesEntry[] {
  const byKey = (a: FilesEntry, b: FilesEntry) => a.key.localeCompare(b.key)
  const base = compare(sort)
  if (tab === "favorites" && sort === "recent") {
    return [...entries].sort((a, b) => (b.favoritedAt ?? 0) - (a.favoritedAt ?? 0) || byKey(a, b))
  }
  if (tab === "recent") {
    return [...entries].sort((a, b) => {
      const pinned = Number(b.favoritedAt !== undefined) - Number(a.favoritedAt !== undefined)
      return pinned || base(a, b) || byKey(a, b)
    })
  }
  return [...entries].sort((a, b) => base(a, b) || byKey(a, b))
}
