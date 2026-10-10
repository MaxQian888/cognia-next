"use client"

/**
 * Everything the Files page draws from, whatever its layout (ADR-0223): the
 * entries and folders, the actions, the view (place × lens × filters ×
 * search), the selection and the URL, plus the paging and the facts both the
 * desktop layout and the phone layout read off them.
 *
 * One model, two bodies: `components/files-library/files-library.tsx` lays it
 * out as a sidebar, a grid or sortable table and a preview pane; on a phone
 * width `components/files-library/mobile/files-mobile-library.tsx` lays the
 * same model out as a two-line list with a place sheet, a preview drawer and a
 * bottom bulk dock. Neither recomputes what the other already knows.
 */

import { useCallback, useMemo, useState } from "react"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesOps } from "@/lib/files-library/ops"
import type { FilesEntry, FilesLens, FilesSection } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import { useFilesBackendContext, useLocalFilesBackend, type FilesSource } from "./files-backend"
import { useFilesActions, type FilesActions } from "./use-files-actions"
import { useFilesDeepLink } from "./use-files-deep-link"
import { useFilesSelection, type FilesSelection } from "./use-files-selection"
import { useFilesView, type FilesView } from "./use-files-view"

/** Items rendered per "Show more" step; keeps a large library's first paint cheap. */
export const FILES_PAGE_SIZE = 60

export interface FilesPage {
  /** Every aggregated entry (undefined while the first load runs). */
  entries: FilesEntry[] | undefined
  folders: LibraryFolder[]
  actions: FilesActions
  view: FilesView
  selection: FilesSelection
  section: FilesSection
  lens: FilesLens
  trash: boolean
  /** The rendered slice of `view.visible`. */
  page: FilesEntry[]
  /** More of the view is waiting behind "Show more". */
  hasMore: boolean
  showMore: () => void
  /** Older images exist beyond the loaded page and this place lists images. */
  showImagesMore: boolean
  loadMoreImages: () => void
  /** Nothing to show: no items and no subfolders. */
  empty: boolean
  /**
   * The template strip belongs on this view (Suggested, All, nothing narrowing
   * it) and documents can be made here (not on a paired device, ADR-0223 §9).
   */
  showTemplates: boolean
  /** Items filed directly in each folder, as the folder view would show them. */
  folderItemCounts: ReadonlyMap<string, number>
  /** The entry the preview shows, if it is still in the library. */
  previewed: FilesEntry | undefined
  /** The library's operations and what it can do here. */
  ops: FilesOps
  /** Read the library again; absent where it is live (this device's own). */
  refresh?: () => Promise<void>
  /** The last read of a remote library failed (a `files.errors.*` code). */
  error?: string
}

/**
 * The page model over the backend `FilesLibrary` mounted. Without one it reads
 * this device's own library, which is what a page rendered on its own (and
 * every test that does so) has always meant.
 */
export function useFilesPage(): FilesPage {
  const mounted = useFilesBackendContext()
  // Mounted either way (hooks keep their order); it reads only when needed.
  const local = useLocalFilesBackend({ enabled: mounted === null })
  const { source, ops } = mounted ?? local
  return useFilesPageOver(source, ops)
}

function useFilesPageOver(source: FilesSource, ops: FilesOps): FilesPage {
  const { entries, imagesTruncated, loadMoreImages, folders } = source
  const actions = useFilesActions(ops)
  const view = useFilesView(entries, folders, source.contentMatches)
  const selection = useFilesSelection(view.visible)
  useFilesDeepLink()

  const section = useFilesLibraryStore((s) => s.section)
  const lens = useFilesLibraryStore((s) => s.lens)
  const sort = useFilesLibraryStore((s) => s.sort)
  const filters = useFilesLibraryStore((s) => s.filters)
  const search = useFilesLibraryStore((s) => s.search)
  const selectedKey = useFilesLibraryStore((s) => s.selectedKey)

  const visible = view.visible
  // "Show more" lasts until the view changes, not until an item is trashed.
  const viewKey = JSON.stringify([section, lens, sort, filters, search])
  const [limit, setLimit] = useState({ for: "", count: FILES_PAGE_SIZE })
  const shown = limit.for === viewKey ? limit.count : FILES_PAGE_SIZE
  const page = useMemo(() => (visible ?? []).slice(0, shown), [visible, shown])
  const showMore = useCallback(
    () => setLimit({ for: viewKey, count: shown + FILES_PAGE_SIZE }),
    [viewKey, shown]
  )

  const folderItemCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of entries ?? []) {
      if (!entry.folderId || entry.trashedAt !== undefined || entry.hidden) continue
      counts.set(entry.folderId, (counts.get(entry.folderId) ?? 0) + 1)
    }
    return counts
  }, [entries])

  const listsImages =
    section.kind === "all" ||
    section.kind === "recent" ||
    (section.kind === "group" && section.group === "images")
  const hasMore = visible !== undefined && visible.length > shown

  return {
    entries,
    folders,
    actions,
    view,
    selection,
    section,
    lens,
    trash: section.kind === "trash",
    page,
    hasMore,
    showMore,
    // Offered once the loaded items are all on screen, so the two never stack.
    showImagesMore: imagesTruncated && listsImages && !hasMore,
    loadMoreImages,
    empty: visible !== undefined && visible.length === 0 && view.childFolders.length === 0,
    // Templates open Suggested, where a new document is most likely to start.
    showTemplates:
      ops.capabilities.createDocuments === true &&
      lens === "suggested" &&
      section.kind === "all" &&
      !view.filtered,
    folderItemCounts,
    previewed: entries?.find((entry) => entry.key === selectedKey),
    ops,
    ...(source.refresh ? { refresh: source.refresh } : {}),
    ...(source.error ? { error: source.error } : {}),
  }
}
