"use client"

/**
 * What the Files page shows right now (ADR-0223): the aggregated entries run
 * through the place, the lens, the filters and the search, in the view's
 * order, plus what the sidebar and the folder view need alongside.
 *
 * "Now" moves once a minute — enough for "modified in the last day" and the
 * Suggested score, without re-sorting a large library every second.
 */

import { useDeferredValue, useEffect, useMemo, useState } from "react"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import { entryRecency } from "@/lib/files-library/aggregate"
import { filterFilesEntries, hasActiveFilters, sortFilesEntries } from "@/lib/files-library/filter"
import { childLibraryFolders } from "@/lib/files-library/folder-tree"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"

/** How many recent items the sidebar lists before "Show more". */
export const FILES_SIDEBAR_RECENTS = 5

const CLOCK_MS = 60_000

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

export interface FilesView {
  /** Every entry the view holds, in order (undefined while loading). */
  visible: FilesEntry[] | undefined
  /** Subfolders of the folder in view; empty outside a folder place. */
  childFolders: LibraryFolder[]
  /** Newest few by activity, for the sidebar (nothing trashed or removed). */
  recents: FilesEntry[]
  /** A search or filter is narrowing the view. */
  filtered: boolean
  /** How many items are in the Trash. */
  trashCount: number
  now: number
}

export function useFilesView(
  entries: readonly FilesEntry[] | undefined,
  folders: readonly LibraryFolder[],
  /** Content matches for the search the entries cannot answer themselves. */
  contentMatches?: ReadonlySet<string>
): FilesView {
  const now = useMinuteClock()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const section = useFilesLibraryStore((s) => s.section)
  const lens = useFilesLibraryStore((s) => s.lens)
  const sort = useFilesLibraryStore((s) => s.sort)
  const filters = useFilesLibraryStore((s) => s.filters)
  const projectScope = useFilesLibraryStore((s) => s.projectScope)
  const search = useFilesLibraryStore((s) => s.search)
  const deferredSearch = useDeferredValue(search)

  const visible = useMemo(() => {
    if (!entries) return undefined
    const query = {
      section,
      lens,
      filters: { ...filters, projectScope },
      search: deferredSearch,
      activeProjectId,
      now,
      ...(contentMatches ? { contentMatches } : {}),
    }
    return sortFilesEntries(filterFilesEntries(entries, query), sort, query)
  }, [
    entries,
    section,
    lens,
    filters,
    projectScope,
    deferredSearch,
    activeProjectId,
    now,
    sort,
    contentMatches,
  ])

  const childFolders = useMemo(
    () => (section.kind === "folder" ? childLibraryFolders(folders, section.folderId) : []),
    [folders, section]
  )

  const { recents, trashCount } = useMemo(() => {
    if (!entries) return { recents: [], trashCount: 0 }
    let trashed = 0
    const live: FilesEntry[] = []
    for (const entry of entries) {
      if (entry.trashedAt !== undefined) trashed += 1
      else if (!entry.hidden) live.push(entry)
    }
    live.sort((a, b) => entryRecency(b) - entryRecency(a) || a.key.localeCompare(b.key))
    return { recents: live.slice(0, FILES_SIDEBAR_RECENTS), trashCount: trashed }
  }, [entries])

  return {
    visible,
    childFolders,
    recents,
    filtered: hasActiveFilters({ ...filters, projectScope }, deferredSearch),
    trashCount,
    now,
  }
}
