"use client"

/**
 * `/files` — every artifact, canvas document, image and file across
 * conversations, as a space you manage (ADR-0223, superseding the layout of
 * ADR-0200).
 *
 *   ┌ sidebar ──────┬ header: place · lenses · search/filter/view · New ┐
 *   │ All, types    │ bulk bar (while selecting)                        │
 *   │ Recents       │ subfolders, then items (grid or sortable list)    │
 *   │ Folder tree   │                                     │ preview     │
 *   │ Trash         │                                     │             │
 *
 * The sidebar picks a place, the tabs a lens; the two combine (the Trash
 * ignores lenses). Items drag onto folders and the Trash; files dragged in
 * from the system upload. The URL carries the place (`?section=`), the lens
 * (`?tab=`) and the previewed item (`?item=`, what ⌘K links to); ADR-0200's
 * `?tab=` values still resolve and are rewritten.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { FolderOpenIcon, Trash2Icon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useFilesActions } from "@/hooks/files-library/use-files-actions"
import { useFilesEntries } from "@/hooks/files-library/use-files-entries"
import { useFilesFolders } from "@/hooks/files-library/use-files-folders"
import { useFilesKeyboard } from "@/hooks/files-library/use-files-keyboard"
import { useFilesSelection } from "@/hooks/files-library/use-files-selection"
import { useFilesView } from "@/hooks/files-library/use-files-view"
import {
  filesLocationHref,
  parseFilesLocation,
  sameFilesSection,
} from "@/lib/files-library/deep-link"
import type { FilesEntry } from "@/lib/files-library/types"
import { detectPlatform } from "@/lib/platform/detect"
import {
  FILES_SIDEBAR_MAX_PX,
  FILES_SIDEBAR_MIN_PX,
  useFilesLibraryStore,
} from "@/stores/files-library"

import { FilesBreadcrumb, useFilesPlaceTitle } from "./files-breadcrumb"
import { FilesBulkBar } from "./files-bulk-bar"
import { FilesCard } from "./files-card"
import { FilesDeleteFolderDialog } from "./files-delete-folder-dialog"
import { FilesDndProvider } from "./files-dnd"
import { FilesDropZone } from "./files-drop-zone"
import { FilesEmpty } from "./files-empty"
import { FilesFolderDialog } from "./files-folder-dialog"
import { FilesFolderTile } from "./files-folder-item"
import { FilesLensTabs } from "./files-lens-tabs"
import { FilesListTable } from "./files-list-table"
import { FilesMobileUnsupported } from "./files-mobile-unsupported"
import { FilesMoveDialog } from "./files-move-dialog"
import { FilesNewMenu } from "./files-new-menu"
import { FilesPreviewPane } from "./files-preview-pane"
import { FilesRenameDialog } from "./files-rename-dialog"
import { FilesSidebar } from "./files-sidebar"
import { FilesToolbar } from "./files-toolbar"
import { FilesTrashDialogs } from "./files-trash-dialogs"

/** Items rendered per "Show more" step; keeps a large library's first paint cheap. */
export const FILES_PAGE_SIZE = 60

const noSubscribe = () => () => {}

export function FilesLibrary() {
  // The platform never changes at runtime; the server snapshot renders the
  // page so the static export and a desktop hydration agree.
  const onPhone = useSyncExternalStore(
    noSubscribe,
    () => detectPlatform() === "mobile",
    () => false
  )
  return onPhone ? <FilesMobileUnsupported /> : <FilesLibraryBody />
}

/**
 * Apply the URL to the view, and keep the URL on the place and lens the
 * person picks. Writes read the store directly, so the first pass never
 * overwrites a deep link with the defaults it is about to replace.
 */
function useFilesDeepLink() {
  const router = useRouter()
  const params = useSearchParams()
  const section = useFilesLibraryStore((s) => s.section)
  const lens = useFilesLibraryStore((s) => s.lens)
  const query = params?.toString() ?? ""

  useEffect(() => {
    const { location, legacy } = parseFilesLocation(new URLSearchParams(query))
    const store = useFilesLibraryStore.getState()
    if (location.section && !sameFilesSection(location.section, store.section)) {
      store.setSection(location.section)
    }
    if (location.lens && location.lens !== store.lens) store.setLens(location.lens)
    if (location.item) store.select(location.item)
    if (legacy) router.replace(filesLocationHref(location))
  }, [query, router])

  useEffect(() => {
    const store = useFilesLibraryStore.getState()
    const { location } = parseFilesLocation(new URLSearchParams(query))
    const urlSection = location.section ?? { kind: "all" as const }
    const urlLens = location.lens ?? "suggested"
    if (sameFilesSection(urlSection, store.section) && urlLens === store.lens) return
    router.replace(filesLocationHref({ section: store.section, lens: store.lens }))
    // `query` is read, not watched: only a change the person made writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, lens, router])
}

function FilesLibraryBody() {
  const t = useTranslations("files")
  const { entries, imagesTruncated, loadMoreImages } = useFilesEntries()
  const folders = useFilesFolders()
  const actions = useFilesActions()
  const view = useFilesView(entries, folders)
  const selection = useFilesSelection(view.visible)
  useFilesDeepLink()

  const section = useFilesLibraryStore((s) => s.section)
  const lens = useFilesLibraryStore((s) => s.lens)
  const viewMode = useFilesLibraryStore((s) => s.viewMode)
  const sort = useFilesLibraryStore((s) => s.sort)
  const setSort = useFilesLibraryStore((s) => s.setSort)
  const selectedKey = useFilesLibraryStore((s) => s.selectedKey)
  const select = useFilesLibraryStore((s) => s.select)
  const resetFilters = useFilesLibraryStore((s) => s.resetFilters)
  const sidebarWidthPx = useFilesLibraryStore((s) => s.sidebarWidthPx)
  const setSidebarWidth = useFilesLibraryStore((s) => s.setSidebarWidth)
  const setEmptyTrashOpen = useFilesLibraryStore((s) => s.setEmptyTrashOpen)
  const placeTitle = useFilesPlaceTitle(folders)
  const trash = section.kind === "trash"

  const onKeyDown = useFilesKeyboard({ entries, selection, trash, actions })

  const filters = useFilesLibraryStore((s) => s.filters)
  const search = useFilesLibraryStore((s) => s.search)
  const visible = view.visible
  // "Show more" lasts until the view changes, not until an item is trashed.
  const viewKey = JSON.stringify([section, lens, sort, filters, search])
  const [limit, setLimit] = useState({ for: "", count: FILES_PAGE_SIZE })
  const shown = limit.for === viewKey ? limit.count : FILES_PAGE_SIZE
  const page = useMemo(() => (visible ?? []).slice(0, shown), [visible, shown])
  const previewed = entries?.find((entry) => entry.key === selectedKey)

  // Items filed directly in each folder, as the folder view would show them.
  const folderItemCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of entries ?? []) {
      if (!entry.folderId || entry.trashedAt !== undefined || entry.hidden) continue
      counts.set(entry.folderId, (counts.get(entry.folderId) ?? 0) + 1)
    }
    return counts
  }, [entries])

  const childFolders = view.childFolders
  const showImagesMore =
    imagesTruncated &&
    (section.kind === "all" ||
      section.kind === "recent" ||
      (section.kind === "group" && section.group === "images"))
  const empty = visible !== undefined && visible.length === 0 && childFolders.length === 0

  const header = (
    <FeaturePageHeader
      icon={
        trash ? (
          <Trash2Icon className="size-5" aria-hidden />
        ) : (
          <FolderOpenIcon className="size-5" aria-hidden />
        )
      }
      title={placeTitle}
      breadcrumb={<FilesBreadcrumb folders={folders} actions={actions} />}
      summary={visible ? t("itemCount", { count: visible.length }) : undefined}
      navigation={trash ? undefined : <FilesLensTabs />}
      controls={<FilesToolbar />}
      actions={
        trash ? (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={view.trashCount === 0}
            onClick={() => setEmptyTrashOpen(true)}
            data-testid="files-empty-trash"
          >
            <Trash2Icon aria-hidden />
            {t("trash.empty")}
          </Button>
        ) : (
          <FilesNewMenu actions={actions} />
        )
      }
      testId="files-header"
    />
  )

  const onSelect = selection.handleClick
  const selecting = selection.selected.size > 0

  return (
    <FilesDndProvider
      entries={entries ?? []}
      folders={folders}
      selected={selection.selected}
      actions={actions}
    >
      <FeaturePageShell
        storageId="files"
        header={header}
        headerPlacement="center"
        centerClassName="min-h-0"
        leftPane={{
          label: t("sidebar.aria"),
          content: (
            <FilesSidebar
              folders={folders}
              recents={view.recents}
              trashCount={view.trashCount}
              actions={actions}
            />
          ),
          defaultSize: `${sidebarWidthPx}px`,
          minSize: `${FILES_SIDEBAR_MIN_PX}px`,
          maxSize: `${FILES_SIDEBAR_MAX_PX}px`,
          onSizeChange: setSidebarWidth,
        }}
        rightPane={
          previewed
            ? {
                label: t("preview.label"),
                content: (
                  <FilesPreviewPane
                    key={previewed.key}
                    entry={previewed}
                    actions={actions}
                    onClose={() => select(null)}
                  />
                ),
                defaultSize: 32,
                minSize: 24,
                maxSize: 50,
                open: true,
                onOpenChange: (open) => {
                  if (!open) select(null)
                },
              }
            : undefined
        }
      >
        <FilesBulkBar
          selected={selection.entries}
          folders={folders}
          trash={trash}
          actions={actions}
          onClear={selection.clear}
        />
        <FilesDropZone actions={actions} disabled={trash} className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex h-full min-h-0 flex-col overflow-y-auto"
            onKeyDown={onKeyDown}
            data-testid="files-body"
          >
            {visible === undefined ? (
              <div
                className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4 p-4"
                aria-busy="true"
                aria-label={t("loading")}
              >
                {Array.from({ length: 12 }, (_, index) => (
                  <Skeleton key={index} className="aspect-square rounded-xl" />
                ))}
              </div>
            ) : empty ? (
              <FilesEmpty
                section={section}
                lens={lens}
                filtered={view.filtered}
                onClear={resetFilters}
              />
            ) : viewMode === "grid" ? (
              <div className="flex flex-col gap-4 p-4">
                {childFolders.length > 0 ? (
                  <ul
                    aria-label={t("folders.subfolders")}
                    className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2"
                    data-testid="files-folder-tiles"
                  >
                    {childFolders.map((folder) => (
                      <li key={folder.id}>
                        <FilesFolderTile
                          folder={folder}
                          itemCount={folderItemCounts.get(folder.id) ?? 0}
                          actions={actions}
                          now={view.now}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div
                  className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4"
                  data-testid="files-grid"
                >
                  {page.map((entry: FilesEntry) => (
                    <FilesCard
                      key={entry.key}
                      entry={entry}
                      actions={actions}
                      previewed={entry.key === selectedKey}
                      selected={selection.selected.has(entry.key)}
                      selecting={selecting}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <FilesListTable
                entries={page}
                folders={childFolders}
                folderItemCounts={folderItemCounts}
                totalInView={visible.length}
                selectedCount={selection.selected.size}
                isSelected={selection.isSelected}
                onSelect={onSelect}
                onSelectAll={selection.selectAll}
                onClearSelection={selection.clear}
                previewedKey={selectedKey}
                sort={sort}
                onSort={setSort}
                trash={trash}
                actions={actions}
                now={view.now}
              />
            )}
            {visible && (visible.length > shown || showImagesMore) ? (
              <div className="flex justify-center gap-2 py-6">
                {visible.length > shown ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLimit({ for: viewKey, count: shown + FILES_PAGE_SIZE })}
                    data-testid="files-show-more"
                  >
                    {t("loadMore")}
                  </Button>
                ) : null}
                {showImagesMore && visible.length <= shown ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadMoreImages}
                    data-testid="files-load-images"
                  >
                    {t("loadOlderImages")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </FilesDropZone>
      </FeaturePageShell>
      <FilesMoveDialog entries={entries ?? []} folders={folders} actions={actions} />
      <FilesRenameDialog entries={entries ?? []} actions={actions} />
      <FilesTrashDialogs entries={entries ?? []} actions={actions} onDeleted={selection.clear} />
      <FilesFolderDialog />
      <FilesDeleteFolderDialog folders={folders} />
    </FilesDndProvider>
  )
}
