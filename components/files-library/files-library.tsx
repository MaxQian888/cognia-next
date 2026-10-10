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
 *
 * A phone-width page draws the same model (`useFilesPage`) as a two-line list
 * instead (`mobile/files-mobile-library.tsx`, ADR-0223 §9).
 */

import { useTranslations } from "next-intl"
import { FolderOpenIcon, Trash2Icon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useFilesKeyboard } from "@/hooks/files-library/use-files-keyboard"
import { useFilesPage } from "@/hooks/files-library/use-files-page"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import type { FilesEntry } from "@/lib/files-library/types"
import {
  FILES_SIDEBAR_MAX_PX,
  FILES_SIDEBAR_MIN_PX,
  useFilesLibraryStore,
} from "@/stores/files-library"

import { FilesBreadcrumb, useFilesPlaceTitle } from "./files-breadcrumb"
import { FilesBulkBar } from "./files-bulk-bar"
import { FilesCard } from "./files-card"
import { FilesDialogs } from "./files-dialogs"
import { FilesDndProvider } from "./files-dnd"
import { FilesDropZone } from "./files-drop-zone"
import { FilesEmpty } from "./files-empty"
import { FilesFolderTile } from "./files-folder-item"
import { FilesLensTabs } from "./files-lens-tabs"
import { FilesListTable } from "./files-list-table"
import { FilesNewMenu } from "./files-new-menu"
import { FilesPreviewPane } from "./files-preview-pane"
import { FilesSidebar } from "./files-sidebar"
import { FilesTemplateStrip } from "./files-template-strip"
import { FilesToolbar } from "./files-toolbar"
import { FilesMobileLibrary } from "./mobile/files-mobile-library"

export { FILES_PAGE_SIZE } from "@/hooks/files-library/use-files-page"

const NO_ENTRIES: readonly FilesEntry[] = []

/**
 * A phone-width page (the phone shell, or a narrow window) gets the compact
 * layout; the model under both is `useFilesPage`.
 */
export function FilesLibrary() {
  const compact = useCompactLayout()
  return compact ? <FilesMobileLibrary /> : <FilesLibraryBody />
}

function FilesLibraryBody() {
  const t = useTranslations("files")
  const files = useFilesPage()
  const { entries, folders, actions, view, selection, section, lens, trash, page } = files

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

  const onKeyDown = useFilesKeyboard({ entries, selection, trash, actions })

  const visible = view.visible
  const previewed = files.previewed
  const folderItemCounts = files.folderItemCounts
  const childFolders = view.childFolders
  const empty = files.empty
  const showTemplates = files.showTemplates

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
      entries={entries ?? NO_ENTRIES}
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
            {showTemplates ? (
              <div className="px-4 pt-4">
                <FilesTemplateStrip actions={actions} />
              </div>
            ) : null}
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
            {visible && (files.hasMore || files.showImagesMore) ? (
              <div className="flex justify-center gap-2 py-6">
                {files.hasMore ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={files.showMore}
                    data-testid="files-show-more"
                  >
                    {t("loadMore")}
                  </Button>
                ) : null}
                {files.showImagesMore ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={files.loadMoreImages}
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
      <FilesDialogs
        entries={entries ?? NO_ENTRIES}
        folders={folders}
        actions={actions}
        onDeleted={selection.clear}
      />
    </FilesDndProvider>
  )
}
