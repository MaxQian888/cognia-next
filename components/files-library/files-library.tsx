"use client"

/**
 * `/files` — every artifact, canvas document, image and file across
 * conversations, in one place (ADR-0200).
 *
 * An aggregated view: the content stays where it lives; Files adds favorites,
 * folders (both keep an item past its conversation), "remove from Files", and
 * its own uploads. `?tab=` selects a tab and `?item=` opens an entry's preview
 * — the deep link ⌘K hands this page.
 */

import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { FolderOpenIcon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useFilesActions } from "@/hooks/files-library/use-files-actions"
import { useFilesEntries } from "@/hooks/files-library/use-files-entries"
import { useFilesFolders } from "@/hooks/files-library/use-files-folders"
import { filterFilesEntries, sortFilesEntries } from "@/lib/files-library/filter"
import { FILES_TABS, type FilesTab } from "@/lib/files-library/types"
import { detectPlatform } from "@/lib/platform/detect"
import { useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"
import { FilesCard } from "./files-card"
import { FilesDeleteDialog } from "./files-delete-dialog"
import { FilesDeleteFolderDialog } from "./files-delete-folder-dialog"
import { FilesEmpty } from "./files-empty"
import { FilesFolderBar } from "./files-folder-bar"
import { FilesFolderDialog } from "./files-folder-dialog"
import { FilesMobileUnsupported } from "./files-mobile-unsupported"
import { FilesMoveDialog } from "./files-move-dialog"
import { FilesNewMenu } from "./files-new-menu"
import { FilesPreviewPane } from "./files-preview-pane"
import { FilesRow } from "./files-row"
import { FilesTabs } from "./files-tabs"
import { FilesToolbar } from "./files-toolbar"

/** Cards rendered per "Show more" step; keeps a large library's first paint cheap. */
export const FILES_PAGE_SIZE = 60

function isFilesTab(value: string | null): value is FilesTab {
  return value !== null && (FILES_TABS as readonly string[]).includes(value)
}

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

function FilesLibraryBody() {
  const t = useTranslations("files")
  const params = useSearchParams()
  const { entries, imagesTruncated, loadMoreImages } = useFilesEntries()
  const folders = useFilesFolders()
  const actions = useFilesActions()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  const tab = useFilesLibraryStore((s) => s.tab)
  const setTab = useFilesLibraryStore((s) => s.setTab)
  const folderId = useFilesLibraryStore((s) => s.folderId)
  const type = useFilesLibraryStore((s) => s.type)
  const setType = useFilesLibraryStore((s) => s.setType)
  const sort = useFilesLibraryStore((s) => s.sort)
  const projectScope = useFilesLibraryStore((s) => s.projectScope)
  const search = useFilesLibraryStore((s) => s.search)
  const setSearch = useFilesLibraryStore((s) => s.setSearch)
  const viewMode = useFilesLibraryStore((s) => s.viewMode)
  const selectedKey = useFilesLibraryStore((s) => s.selectedKey)
  const select = useFilesLibraryStore((s) => s.select)
  const deferredSearch = useDeferredValue(search)

  // Deep link: `?tab=` then `?item=`, applied when the query changes.
  const tabParam = params?.get("tab") ?? null
  const itemParam = params?.get("item") ?? null
  useEffect(() => {
    if (isFilesTab(tabParam)) setTab(tabParam)
    if (itemParam) select(itemParam)
  }, [tabParam, itemParam, setTab, select])

  const visible = useMemo(() => {
    if (!entries) return []
    const filtered = filterFilesEntries(entries, {
      tab,
      folderId,
      type,
      search: deferredSearch,
      projectScope,
      activeProjectId,
    })
    return sortFilesEntries(filtered, sort, tab)
  }, [entries, tab, folderId, type, deferredSearch, projectScope, activeProjectId, sort])

  const [limit, setLimit] = useState({ for: "", count: FILES_PAGE_SIZE })
  const viewKey = `${tab}|${folderId}|${type}|${deferredSearch}|${projectScope}|${sort}`
  const shown = limit.for === viewKey ? limit.count : FILES_PAGE_SIZE
  const page = visible.slice(0, shown)
  const selected = entries?.find((entry) => entry.key === selectedKey)
  const filtered = deferredSearch.trim().length > 0 || type !== "all"

  const header = (
    <FeaturePageHeader
      icon={<FolderOpenIcon className="size-5" aria-hidden />}
      title={t("title")}
      description={t("description")}
      summary={entries ? t("itemCount", { count: visible.length }) : undefined}
      navigation={<FilesTabs />}
      controls={<FilesToolbar />}
      actions={<FilesNewMenu actions={actions} />}
      testId="files-header"
    />
  )

  return (
    <>
      <FeaturePageShell
        storageId="files"
        header={header}
        centerClassName="min-h-0"
        rightPane={
          selected
            ? {
                label: t("preview.label"),
                content: (
                  <FilesPreviewPane
                    key={selected.key}
                    entry={selected}
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
        <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="files-body">
          {tab === "folders" ? <FilesFolderBar folders={folders} /> : null}
          {!entries ? (
            <div
              className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4 p-4"
              aria-busy="true"
              aria-label={t("loading")}
            >
              {Array.from({ length: 12 }, (_, index) => (
                <Skeleton key={index} className="aspect-square rounded-xl" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <FilesEmpty
              tab={tab}
              filtered={filtered}
              onClear={() => {
                setSearch("")
                setType("all")
              }}
            />
          ) : viewMode === "grid" ? (
            <div
              className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4 p-4"
              data-testid="files-grid"
            >
              {page.map((entry) => (
                <FilesCard
                  key={entry.key}
                  entry={entry}
                  actions={actions}
                  selected={entry.key === selectedKey}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 p-2" data-testid="files-list">
              {page.map((entry) => (
                <FilesRow
                  key={entry.key}
                  entry={entry}
                  actions={actions}
                  selected={entry.key === selectedKey}
                />
              ))}
            </div>
          )}
          {entries &&
          (visible.length > shown ||
            (imagesTruncated && (tab === "images" || tab === "all" || tab === "recent"))) ? (
            <div className="flex justify-center gap-2 pb-6">
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
              {imagesTruncated && visible.length <= shown ? (
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
      </FeaturePageShell>
      <FilesMoveDialog entries={entries ?? []} folders={folders} actions={actions} />
      <FilesFolderDialog />
      <FilesDeleteDialog entries={entries ?? []} actions={actions} />
      <FilesDeleteFolderDialog folders={folders} />
    </>
  )
}
