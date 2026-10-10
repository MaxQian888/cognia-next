"use client"

/**
 * `/files` on a phone-width page (ADR-0223 §9): the same model as the desktop
 * page (`useFilesPage`) laid out for a touch screen.
 *
 *   ┌───────────────────────────────────────┐
 *   │ [≡ All ▾ · 42 items]        [☐] [+]   │  place sheet · Select · New
 *   │ All folders › Research ⋯              │  (in a folder)
 *   │ Suggested  Favorites  Mine  AI  …     │  lenses, scrolling
 *   │ [🔍 Search files            ] [Filter]│
 *   ├───────────────────────────────────────┤
 *   │ Start from a template …               │
 *   │ [📁] Research            3 d      ⋯   │  subfolders first
 *   │ [🖼] diagram.png          2 hr     ⋯   │  two-line, 44px+ rows
 *   ├───────────────────────────────────────┤
 *   │ 3 selected        Select all · Done   │  bulk dock, while selecting
 *   │ [★] [→] [⇪] [↓] [🗑]                   │
 *   └───────────────────────────────────────┘
 *
 * The sidebar becomes a sheet from the place button, closed again by picking
 * a place or a recent item. A tap on a row previews it in a bottom drawer
 * (Open, Use in chat, Download, Favorite); a long-press — or "Select" — turns
 * the list into selection mode, where a tap toggles and the dock acts on the
 * whole selection. The list is the phone's only layout: grid/list is a desktop
 * preference and stays what it was. Nothing drags here; files come in through
 * "New → Upload files", the system file picker.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckSquareIcon, ChevronDownIcon, PanelLeftIcon, SearchIcon, Trash2Icon } from "lucide-react"

import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { Surface } from "@/components/surface/surface"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { displayTitle } from "@/hooks/files-library/use-files-actions"
import { useFilesPage } from "@/hooks/files-library/use-files-page"
import { serializeFilesSection } from "@/lib/files-library/deep-link"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FilesBreadcrumb, useFilesPlaceTitle } from "../files-breadcrumb"
import { FilesDialogs } from "../files-dialogs"
import { FilesEmpty } from "../files-empty"
import { FilesFilterPopover } from "../files-filter-popover"
import { FilesLensTabs } from "../files-lens-tabs"
import { FilesNewMenu } from "../files-new-menu"
import { FilesPreviewPane } from "../files-preview-pane"
import { FilesSidebar } from "../files-sidebar"
import { FilesTemplateStrip } from "../files-template-strip"
import { FilesMobileBulkBar } from "./files-mobile-bulk-bar"
import { FilesMobileFolderRow } from "./files-mobile-folder-row"
import { FilesMobileRow } from "./files-mobile-row"

const NO_ENTRIES: readonly FilesEntry[] = []

/** A modifier-free toggle, the way a checkbox toggles one item. */
const TOGGLE = { ctrlKey: true, metaKey: false, shiftKey: false } as const

export function FilesMobileLibrary() {
  const t = useTranslations("files")
  const files = useFilesPage()
  const { entries, folders, actions, view, selection, section, lens, trash, page } = files
  const visible = view.visible
  const placeTitle = useFilesPlaceTitle(folders)
  const search = useFilesLibraryStore((s) => s.search)
  const setSearch = useFilesLibraryStore((s) => s.setSearch)
  const selectedKey = useFilesLibraryStore((s) => s.selectedKey)
  const select = useFilesLibraryStore((s) => s.select)
  const resetFilters = useFilesLibraryStore((s) => s.resetFilters)
  const setEmptyTrashOpen = useFilesLibraryStore((s) => s.setEmptyTrashOpen)

  // Selection mode belongs to the place it started in: `useFilesSelection`
  // clears the selection on a place or lens change, and the mode ends with it.
  const place = `${serializeFilesSection(section)}|${lens}`
  const [selectingIn, setSelectingIn] = useState<string | null>(null)
  const selecting = selectingIn === place || selection.selected.size > 0
  const { clear, handleClick, isSelected, selectAll } = selection
  // Entering the mode drops the preview: the drawer would otherwise come
  // back for that item the moment the mode ends.
  const enterSelecting = useCallback(() => {
    setSelectingIn(place)
    select(null)
  }, [place, select])
  const startSelecting = useCallback(
    (key: string) => {
      enterSelecting()
      if (!isSelected(key)) handleClick(key, TOGGLE)
    },
    [enterSelecting, isSelected, handleClick]
  )
  const toggle = useCallback((key: string) => handleClick(key, TOGGLE), [handleClick])
  const stopSelecting = useCallback(() => {
    setSelectingIn(null)
    clear()
  }, [clear])

  // The place sheet closes once it has done its job: a place picked, or a
  // recent item opened (which previews it, under the sheet otherwise).
  const sheetScope = `${place}|${selectedKey ?? ""}`
  const [placesOpenFor, setPlacesOpenFor] = useState<string | null>(null)
  const placesOpen = placesOpenFor === sheetScope

  // A tap toggles while selecting, so the drawer only follows a preview.
  const previewed = selecting ? undefined : files.previewed
  const count = visible?.length

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
      data-bg-target="chat"
      data-testid="files-mobile"
    >
      <header className="shrink-0 space-y-2 border-b px-3 pt-2 pb-2" data-testid="files-header">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            className="h-11 min-w-0 flex-1 justify-start gap-2 px-2"
            onClick={() => {
              // A place picked from the sheet ends selection anyway; a recent
              // item opened from it previews, which selection mode would hide.
              stopSelecting()
              select(null)
              setPlacesOpenFor(`${place}|`)
            }}
            aria-haspopup="dialog"
            aria-expanded={placesOpen}
            aria-label={t("mobile.places", { place: placeTitle })}
            data-testid="files-mobile-places"
          >
            {trash ? (
              <Trash2Icon className="size-5 shrink-0" aria-hidden />
            ) : (
              <PanelLeftIcon className="size-5 shrink-0" aria-hidden />
            )}
            <span className="flex min-w-0 flex-col items-start leading-tight">
              <span className="flex min-w-0 max-w-full items-center gap-1 text-base font-semibold">
                <span className="truncate">{placeTitle}</span>
                <ChevronDownIcon className="size-4 shrink-0 opacity-60" aria-hidden />
              </span>
              {count !== undefined ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {t("itemCount", { count })}
                </span>
              ) : null}
            </span>
          </Button>
          {count ? (
            <Button
              variant={selecting ? "secondary" : "ghost"}
              size="icon"
              className="size-10 shrink-0"
              aria-label={t("mobile.select")}
              aria-pressed={selecting}
              onClick={() => (selecting ? stopSelecting() : enterSelecting())}
              data-testid="files-mobile-select"
            >
              <CheckSquareIcon className="size-5" aria-hidden />
            </Button>
          ) : null}
          {trash ? (
            <Button
              variant="outline"
              className="h-10 shrink-0 text-destructive hover:text-destructive"
              disabled={view.trashCount === 0}
              onClick={() => setEmptyTrashOpen(true)}
              data-testid="files-empty-trash"
            >
              {t("trash.empty")}
            </Button>
          ) : (
            <FilesNewMenu actions={actions} compact />
          )}
        </div>
        {section.kind === "folder" ? (
          <div className="flex min-h-9 items-center px-1">
            <FilesBreadcrumb folders={folders} actions={actions} />
          </div>
        ) : null}
        {trash ? null : (
          <div className="-mx-3 overflow-x-auto px-3 [scrollbar-width:none]">
            <FilesLensTabs />
          </div>
        )}
        <div className="flex items-center gap-2">
          <InputGroup className="h-10 min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("search.placeholder")}
              aria-label={t("search.aria")}
              data-testid="files-search"
            />
          </InputGroup>
          <FilesFilterPopover compact />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="files-body">
        {files.showTemplates ? (
          <div className="px-3 pt-3">
            <FilesTemplateStrip actions={actions} />
          </div>
        ) : null}
        {visible === undefined ? (
          <div className="space-y-2 p-3" aria-busy="true" aria-label={t("loading")}>
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-md" />
            ))}
          </div>
        ) : files.empty ? (
          <FilesEmpty
            section={section}
            lens={lens}
            filtered={view.filtered}
            onClear={resetFilters}
            touch
          />
        ) : (
          <div className="p-3">
            <Surface layer="raised" radius="panel" className="overflow-hidden border">
              <ul aria-label={placeTitle} className="flex flex-col" data-testid="files-mobile-list">
                {view.childFolders.map((folder) => (
                  <FilesMobileFolderRow
                    key={folder.id}
                    folder={folder}
                    itemCount={files.folderItemCounts.get(folder.id) ?? 0}
                    actions={actions}
                    now={view.now}
                  />
                ))}
                {page.map((entry) => (
                  <FilesMobileRow
                    key={entry.key}
                    entry={entry}
                    actions={actions}
                    selecting={selecting}
                    selected={isSelected(entry.key)}
                    previewed={!selecting && entry.key === selectedKey}
                    onStartSelecting={startSelecting}
                    onToggle={toggle}
                    now={view.now}
                  />
                ))}
              </ul>
            </Surface>
          </div>
        )}
        {visible && (files.hasMore || files.showImagesMore) ? (
          <div className="flex justify-center px-3 pb-6">
            {files.hasMore ? (
              <Button
                variant="outline"
                className="h-11 w-full"
                onClick={files.showMore}
                data-testid="files-show-more"
              >
                {t("loadMore")}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="h-11 w-full"
                onClick={files.loadMoreImages}
                data-testid="files-load-images"
              >
                {t("loadOlderImages")}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {selecting ? (
        <FilesMobileBulkBar
          selected={selection.entries}
          visibleCount={visible?.length ?? 0}
          folders={folders}
          trash={trash}
          actions={actions}
          onSelectAll={selectAll}
          onClear={clear}
          onDone={stopSelecting}
        />
      ) : null}

      <Sheet
        open={placesOpen}
        onOpenChange={(open) => setPlacesOpenFor(open ? sheetScope : null)}
      >
        <SheetContent
          side="left"
          className="w-[300px] max-w-[85vw] p-0 pt-[env(safe-area-inset-top)]"
          data-testid="files-mobile-places-sheet"
        >
          <SheetTitle className="sr-only">{t("sidebar.aria")}</SheetTitle>
          <SheetDescription className="sr-only">{t("mobile.placesDescription")}</SheetDescription>
          <FilesSidebar
            folders={folders}
            recents={view.recents}
            trashCount={view.trashCount}
            actions={actions}
            touch
          />
        </SheetContent>
      </Sheet>

      <ResponsiveDetailSheet
        open={previewed !== undefined}
        onOpenChange={(open) => {
          if (!open) select(null)
        }}
        title={previewed ? displayTitle(previewed, t) : t("preview.label")}
        headerVisuallyHidden
        showCloseButton={false}
        contentClassName="flex h-[85dvh] flex-col"
      >
        {previewed ? (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="files-mobile-preview">
            <FilesPreviewPane
              key={previewed.key}
              entry={previewed}
              actions={actions}
              onClose={() => select(null)}
              touch
            />
          </div>
        ) : null}
      </ResponsiveDetailSheet>

      <FilesDialogs
        entries={entries ?? NO_ENTRIES}
        folders={folders}
        actions={actions}
        onDeleted={stopSelecting}
      />
    </div>
  )
}
