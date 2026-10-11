"use client"

// Library list body. Switches between the new compact list view and the
// pre-existing card grid (`PluginPanelGrid`) based on `listViewMode` from
// the plugins store. Handles three empty cases:
//
//   - loading                      → skeleton
//   - no plugins installed at all  → reuse Empty compound + Discover CTA
//   - filters yield nothing        → a sentence and a "Clear filters" action
//                                    (it used to be a bordered card with no
//                                    way out but finding the right chip)
//
// The head bar above the rows carries selection, and on a window without the
// nav rail the Categories sheet trigger too, so the facets never cost a row
// of their own:
//
//   desktop / tablet  [☐ Select all (52)]                     checkboxes always on
//   phone             [Categories]  52 plugins       [Select]  checkboxes hidden
//   phone, selecting  [☐ Select all (52)]                [Done] tap = toggle
//
// On a phone a checkbox on every row costs ~36px of a 375px row for a control
// most visits never use, so selection is a mode: the Select button or a long
// press on a row enters it, Done leaves it (and drops the selection).
//
// Rows are reachable by keyboard as a list: ArrowUp / ArrowDown move between
// rows, Home / End jump to the ends, Enter opens the focused row.
//
// Selection / open-detail / configure / uninstall / review-permissions /
// rollback handlers are wired here so PluginLibraryRow stays presentation-
// only; this matches the wiring already done by `plugin-panel-grid.tsx`.

import { useCallback, useRef, type KeyboardEvent } from "react"
import { useLocale, useTranslations } from "next-intl"
import { BoxesIcon, CheckIcon, CompassIcon, ListChecksIcon, SearchXIcon } from "lucide-react"
import type { PluginRow } from "@/lib/db/plugin-types"
import { usePlugins } from "@/hooks/plugins"
import { usePluginEnableAction } from "@/hooks/plugins/use-plugin-enable-action"
import { localizePluginText } from "@/hooks/plugins/use-localized-plugin-text"
import { usePluginsStore } from "@/stores/plugins"
import { useBreakpoint } from "@/hooks/ui"
import { PluginCategorySheet } from "../dialogs/plugin-category-sheet"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { PluginPanelGrid } from "../plugin-panel-grid"
import { PluginLibraryRow } from "./plugin-library-row"
import { PluginLibraryListSkeleton, PluginLibraryGridSkeleton } from "./plugin-library-skeleton"

export function PluginLibraryList() {
  const t = useTranslations("plugins.grid")
  const locale = useLocale()
  const tEmpty = useTranslations("plugins")
  const { filtered, totals, loading } = usePlugins()
  const viewMode = usePluginsStore((s) => s.listViewMode)
  const selection = usePluginsStore((s) => s.selection)
  const toggleSelection = usePluginsStore((s) => s.toggleSelection)
  const detailPluginId = usePluginsStore((s) => s.detailPluginId)
  const openDetail = usePluginsStore((s) => s.openDetail)
  const openConfigure = usePluginsStore((s) => s.openConfigure)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const selectAll = usePluginsStore((s) => s.selectAll)
  const clearSelection = usePluginsStore((s) => s.clearSelection)
  const selectionMode = usePluginsStore((s) => s.selectionMode)
  const setSelectionMode = usePluginsStore((s) => s.setSelectionMode)
  const resetFilters = usePluginsStore((s) => s.resetFilters)
  const setLibrarySubFilter = usePluginsStore((s) => s.setLibrarySubFilter)
  const breakpoint = useBreakpoint()
  const phone = breakpoint === "mobile"
  // The facets live in the nav rail only at desktop width.
  const categoriesInline = breakpoint !== "desktop"
  const selectable = !phone || selectionMode
  const listRef = useRef<HTMLDivElement>(null)

  // Stable handlers so the memoized rows only re-render when their own
  // plugin / selected / active props change (matters for 50+ plugin lists
  // where every keystroke used to re-render every row).
  // Through the feedback hook, not straight to `setPluginEnabledForHost`: the
  // user is told whether the toggle applied, was queued for the desktop, or
  // failed (and why), instead of the result being dropped.
  const enablePlugin = usePluginEnableAction()
  const handleToggleEnabled = useCallback(
    (plugin: PluginRow) => void enablePlugin(plugin, !plugin.enabled),
    [enablePlugin]
  )
  // In phone selection mode a tap on a row toggles it, which is what every
  // phone list does once checkboxes are showing; opening the detail drawer
  // over a selection in progress would lose the user's place.
  const handleOpen = useCallback(
    (id: string) => (phone && selectionMode ? toggleSelection(id) : openDetail(id)),
    [phone, selectionMode, toggleSelection, openDetail]
  )
  const handleLongPress = useCallback(
    (id: string) => {
      setSelectionMode(true)
      if (!usePluginsStore.getState().selection.has(id)) toggleSelection(id)
    },
    [setSelectionMode, toggleSelection]
  )
  const handleListKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"]
    if (!keys.includes(event.key)) return
    const openers = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-row-open]") ?? []
    )
    if (openers.length === 0) return
    const current = openers.findIndex((el) => el === document.activeElement)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? openers.length - 1
          : event.key === "ArrowDown"
            ? Math.min(openers.length - 1, current + 1)
            : Math.max(0, current === -1 ? 0 : current - 1)
    event.preventDefault()
    openers[next]?.focus()
    openers[next]?.scrollIntoView?.({ block: "nearest" })
  }, [])
  const handleUninstall = useCallback(
    (plugin: PluginRow) =>
      setDeleteTarget({ pluginId: plugin.id, name: localizePluginText(plugin, locale).name }),
    [setDeleteTarget, locale]
  )

  if (loading) {
    return (
      <div className="p-4">
        {viewMode === "card" ? <PluginLibraryGridSkeleton /> : <PluginLibraryListSkeleton />}
      </div>
    )
  }

  if (totals.total === 0) {
    return (
      <div className="p-4">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>{t("emptyAll")}</EmptyTitle>
            <EmptyDescription>{tEmpty("description")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setActiveSection("discover")}>
              <CompassIcon className="mr-1.5 size-3.5" />
              {t("browseMarketplace")}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  // Select-all over the *visible* (filtered) set — the batch-actions bar
  // appears as soon as anything is selected, so this is the entry point for
  // bulk enable/disable/uninstall without checking rows one by one.
  const allSelected = filtered.length > 0 && filtered.every((row) => selection.has(row.id))
  const someSelected = !allSelected && filtered.some((row) => selection.has(row.id))
  const headBar = (
    <div
      className="sticky top-0 z-20 flex min-h-9 items-center gap-2 border-b bg-background/95 px-3 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      data-testid="plugin-library-head"
    >
      {selectable && filtered.length > 0 ? (
        <label className="-my-1 flex cursor-pointer items-center gap-2 py-1 pointer-coarse:min-h-10">
          <Checkbox
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={() =>
              allSelected ? clearSelection() : selectAll(filtered.map((row) => row.id))
            }
            aria-label={t("selectAllAria")}
            data-testid="plugin-library-select-all"
          />
          <span className="text-xs text-muted-foreground">
            {t("selectAll", { count: filtered.length })}
          </span>
        </label>
      ) : (
        <>
          {categoriesInline ? <PluginCategorySheet /> : null}
          <span className="text-xs text-muted-foreground" data-testid="plugin-library-count">
            {t("pluginCount", { count: filtered.length })}
          </span>
        </>
      )}
      {phone ? (
        <Button
          type="button"
          size="sm"
          variant={selectionMode ? "default" : "ghost"}
          className="ml-auto h-8 gap-1.5 px-2.5 text-xs pointer-coarse:h-10"
          onClick={() => setSelectionMode(!selectionMode)}
          aria-pressed={selectionMode}
          data-testid="plugin-library-selection-mode"
        >
          {selectionMode ? (
            <CheckIcon className="size-3.5" aria-hidden />
          ) : (
            <ListChecksIcon className="size-3.5" aria-hidden />
          )}
          {selectionMode ? t("selectionDone") : t("selectionStart")}
        </Button>
      ) : categoriesInline && selectable ? (
        <div className="ml-auto">
          <PluginCategorySheet />
        </div>
      ) : null}
    </div>
  )

  if (filtered.length === 0) {
    return (
      <>
        {headBar}
        <div
          className="flex flex-col items-center gap-2 px-6 py-10 text-center"
          data-testid="plugin-library-no-match"
        >
          <SearchXIcon className="size-7 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">{t("emptyFiltered")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="pointer-coarse:h-10"
            onClick={() => {
              resetFilters()
              setLibrarySubFilter("all")
            }}
            data-testid="plugin-library-clear-filters"
          >
            {t("clearFilters")}
          </Button>
        </div>
      </>
    )
  }

  if (viewMode === "card") {
    return (
      <>
        {headBar}
        <div className="p-4">
          <PluginPanelGrid />
        </div>
      </>
    )
  }

  return (
    <>
      {headBar}
      {/* `overflow-x-hidden`: the rows clip their own content, and this makes
          the guarantee structural. A single row that manages to overflow must
          not be able to give the whole list a horizontal scrollbar. */}
      <div
        ref={listRef}
        role="list"
        aria-label={t("listAria")}
        className="min-w-0 divide-y overflow-x-hidden"
        data-testid="plugin-library-list"
        onKeyDown={handleListKeyDown}
      >
        {filtered.map((row) => (
          <PluginLibraryRow
            key={row.id}
            plugin={row}
            selected={selection.has(row.id)}
            selectable={selectable}
            active={detailPluginId === row.id}
            onToggleSelect={toggleSelection}
            onOpen={handleOpen}
            onLongPress={phone && !selectionMode ? handleLongPress : undefined}
            onConfigure={openConfigure}
            onToggleEnabled={handleToggleEnabled}
            onUninstall={handleUninstall}
            onReviewPermissions={openPermissionReview}
            onRollback={setRollbackTarget}
          />
        ))}
      </div>
    </>
  )
}
