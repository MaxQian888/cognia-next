"use client"

/**
 * `/memory` on a compact layout — phones, the Capacitor shell, and any window
 * narrower than 768px.
 *
 * It used to be a different, smaller program than the desktop console: a
 * search box over a list with three resident buttons per row, no add, no
 * quick views, no detail, no delete, no conflict resolution, and writes that
 * went to the outbound queue whether or not a host existed (a narrow Tauri
 * window queued RPCs at itself; a standalone phone queued them for nobody).
 * It now runs the console's own state and commands (`useMemoryConsole`) and
 * only arranges them for a thumb:
 *
 *   - a sticky header: back, title, add; the Memories / Health tabs; search +
 *     a filter drawer; the quick views as a sideways-scrolling chip row — or,
 *     while selecting, the bulk actions in that same band (the tab bar owns
 *     the bottom edge, so a bottom dock would sit under it);
 *   - a full-bleed list (rows divided by rules, no cards), tap to open, long
 *     press to select, one ⋯ menu per row;
 *   - the inspector as a full-screen sheet the selection opens.
 *
 * Pull to refresh pulls the `memories` table from the host on a paired client.
 * A device that owns its store has nothing to pull, so it re-reads instead.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ListFilterIcon, MoreHorizontalIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { EmptyState } from "@/components/mobile/empty-state"
import { MobileBackButton } from "@/components/mobile/shell/mobile-back-button"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { MemoryBulkToolbar } from "@/components/memory/memory-bulk-toolbar"
import { MemoryConsoleDialogs } from "@/components/memory/memory-console-dialogs"
import { MemoryFilterDrawer } from "@/components/memory/memory-filter-drawer"
import { MemoryHealthPanel } from "@/components/memory/memory-health-panel"
import { MemoryHostChip } from "@/components/memory/memory-host-chip"
import { MemoryInspector } from "@/components/memory/memory-inspector"
import { MemoryQuickViews } from "@/components/memory/memory-toolbar"
import { MemoryTouchRow } from "@/components/memory/memory-touch-row"
import { ExternalMemoryTab } from "@/components/memory/external/external-memory-tab"
import { useMemoryConsole, type MemoryConsoleTab } from "@/hooks/memory/use-memory-console"
import { useMemoryLint } from "@/hooks/memory/use-memory-lint"
import { countActiveMemoryFilters } from "@/lib/memory/history-filter"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { COMPACT_PAGE_MIN_H } from "@/lib/shell/compact-shell"

export interface MemoryMobileBodyProps {
  /** Open this memory's inspector once (`/memory?id=` from chat chips). */
  initialSelectedId?: string
  /** Only this workspace's memories (`/memory?workspace=` deep link, ADR-0204). */
  projectId?: string
}

const ESTIMATED_ROW_HEIGHT = 88

export function MemoryMobileBody({ initialSelectedId, projectId }: MemoryMobileBodyProps = {}) {
  const t = useTranslations("memory.panel")
  const tMobile = useTranslations("mobile.memory")
  const state = useMemoryConsole({ initialSelectedId, initialProjectId: projectId })
  const { rows, tab, setTab, selecting, selectedIds, authority } = state
  const onHost = authority === "host"
  const [filterOpen, setFilterOpen] = useState(false)
  const lint = useMemoryLint(state.all, tab === "health")

  // External agent files are on the disk of the machine running this — only a
  // (narrow) desktop window that owns its store has any to show.
  const tabs = useMemo<readonly MemoryConsoleTab[]>(
    () => (isTauri() && !onHost ? ["app", "health", "external"] : ["app", "health"]),
    [onHost]
  )
  const activeFilters = countActiveMemoryFilters(state.filter)
  const selectionMode = selecting || selectedIds.size > 0

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => rows[index]?.id ?? index,
  })

  // One-shot deep-link scroll once the target row is present in the live list.
  const scrolledRef = useRef(false)
  useEffect(() => {
    if (!initialSelectedId || scrolledRef.current) return
    const index = rows.findIndex((row) => row.id === initialSelectedId)
    if (index < 0) return
    scrolledRef.current = true
    virtualizer.scrollToIndex(index, { align: "center" })
  }, [initialSelectedId, rows, virtualizer])

  const refresh = async (): Promise<void> => {
    if (!onHost) return
    const { runSyncDown } = await import("@/lib/sync/companion-sync")
    await runSyncDown({ only: ["memories"] }).catch(() => undefined)
  }

  const list =
    state.isLoading ? (
      <ListSkeleton rows={5} testId="mobile-memory-loading" />
    ) : state.all.length === 0 ? (
      <EmptyState
        spotIcon="memory"
        title={tMobile("empty")}
        description={tMobile("emptyDescription")}
        cta={{
          label: t("addFirst"),
          onSelect: () => state.setAddOpen(true),
          testId: "mobile-memory-add-first",
        }}
      />
    ) : rows.length === 0 ? (
      <EmptyState
        spotIcon="memory"
        title={tMobile("noMatches")}
        description={tMobile("noMatchesDescription")}
        cta={{
          label: t("clearFilters"),
          onSelect: state.clearFilters,
          testId: "mobile-memory-clear-search",
        }}
      />
    ) : (
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
        data-testid="mobile-memory-virtual-list"
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const memory = rows[virtualRow.index]
          if (!memory) return null
          return (
            <div
              key={memory.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <MemoryTouchRow
                memory={memory}
                active={memory.id === state.selectedId}
                selecting={selectionMode}
                selected={selectedIds.has(memory.id)}
                onOpen={state.open}
                onToggleSelect={state.toggleSelect}
                onStartSelecting={state.startSelecting}
                onPinToggle={(id, pinned) => state.pin([id], pinned)}
                onArchive={(id) => void state.archive([id])}
                onRestore={(id) => void state.restore([id])}
                onMove={state.setMoveId}
                onCopy={state.copyText}
                onDelete={(id) => state.requestDelete([id])}
              />
            </div>
          )
        })}
      </div>
    )

  return (
    <main
      className={cn(COMPACT_PAGE_MIN_H, "flex w-full min-w-0 flex-col bg-background safe-area-pt")}
      data-testid="mobile-memory-body"
    >
      <header className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background/95 pb-2 pt-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center gap-1 px-2">
          <MobileBackButton />
          <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          {onHost ? <MemoryHostChip /> : null}
          {tab === "app" ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-11"
              aria-label={t("add")}
              onClick={() => state.setAddOpen(true)}
              data-testid="mobile-memory-add"
            >
              <PlusIcon className="size-5" />
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-11"
                aria-label={t("moreActions")}
                data-testid="mobile-memory-more"
              >
                <MoreHorizontalIcon className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem asChild>
                <Link href="/me/memory-settings">
                  <SettingsIcon className="size-4" />
                  {t("openSettings")}
                </Link>
              </DropdownMenuItem>
              {tab === "app" ? (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={rows.length === 0}
                  onSelect={() => state.requestDelete(state.visibleIds)}
                  data-testid="mobile-memory-clear-filtered"
                >
                  <Trash2Icon className="size-4" />
                  {t("clearFiltered")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          role="tablist"
          aria-label={t("tabsLabel")}
          className={cn("mx-4 grid gap-1 rounded-lg bg-muted p-1", tabs.length === 3 ? "grid-cols-3" : "grid-cols-2")}
        >
          {tabs.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              onClick={() => setTab(candidate)}
              data-testid={`mobile-memory-tab-${candidate}`}
              className={cn(
                "flex h-8 min-w-0 items-center justify-center gap-1.5 truncate rounded-md px-2 text-sm",
                tab === candidate
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground"
              )}
            >
              <span className="truncate">{t(`tabs.${candidate}`)}</span>
              {candidate === "app" ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {state.viewCounts.all}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {tab === "app" ? (
          selectionMode ? (
            <MemoryBulkToolbar
              layout="compact"
              selectedCount={selectedIds.size}
              visibleCount={state.visibleIds.length}
              allSelected={state.allVisibleSelected}
              busy={state.bulkBusy}
              archivedView={state.archivedView}
              onToggleSelectAll={state.selectAllVisible}
              onPin={() => state.pin([...selectedIds], true)}
              onUnpin={() => state.pin([...selectedIds], false)}
              onArchive={() => void state.archive([...selectedIds])}
              onRestore={() => void state.restore([...selectedIds])}
              onDelete={() => state.requestDelete([...selectedIds])}
              onClear={state.clearSelection}
            />
          ) : (
            <>
              <div className="flex items-center gap-2 px-4">
                <Input
                  type="search"
                  value={state.filter.query ?? ""}
                  onChange={(event) => state.setFilter({ ...state.filter, query: event.target.value })}
                  placeholder={t("searchPlaceholder")}
                  aria-label={t("searchLabel")}
                  className="h-10 min-w-0 flex-1"
                  data-testid="mobile-memory-search"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="relative size-10 shrink-0"
                  aria-label={t("filter.drawerTitle")}
                  onClick={() => setFilterOpen(true)}
                  data-testid="mobile-memory-filter"
                >
                  <ListFilterIcon className="size-4" />
                  {activeFilters > 0 ? (
                    <Badge className="absolute -right-1 -top-1 h-4 min-w-4 px-1 text-[10px] tabular-nums">
                      {activeFilters}
                    </Badge>
                  ) : null}
                </Button>
              </div>
              <MemoryQuickViews
                view={state.view}
                onViewChange={state.setView}
                viewCounts={state.viewCounts}
                size="touch"
                className="px-4"
              />
            </>
          )
        ) : null}
      </header>

      {tab === "app" ? (
        <PullToRefresh onRefresh={refresh} onScrollElChange={setScrollEl} className="flex-1">
          <section className="pb-4" aria-label={t("listLabel")}>
            {list}
          </section>
        </PullToRefresh>
      ) : tab === "health" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <MemoryHealthPanel
            report={lint.report}
            loading={lint.loading}
            onRefresh={lint.refresh}
            resolveMemory={state.resolveMemory}
            onOpenMemory={state.openFromHealth}
            mirror={onHost}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ExternalMemoryTab onHost={onHost} />
        </div>
      )}

      <Sheet
        open={tab === "app" && Boolean(state.selectedMemory)}
        onOpenChange={(open) => {
          if (!open) state.close()
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full p-0 sm:max-w-md safe-area-pt"
          data-testid="mobile-memory-inspector"
        >
          <SheetTitle className="sr-only">{t("detailTitle")}</SheetTitle>
          {state.selectedMemory ? (
            <MemoryInspector
              key={state.selectedMemory.id}
              memory={state.selectedMemory}
              resolveMemory={state.resolveMemory}
              onClose={state.close}
              onSave={state.saveInspector}
              onPinToggle={(id, pinned) => state.pin([id], pinned)}
              onArchive={(id) => void state.archive([id])}
              onRestore={(id) => void state.restore([id])}
              onMove={state.setMoveId}
              onCopy={state.copyText}
              onDelete={(id) => state.requestDelete([id])}
              initialEditing={state.editRequested}
              onReview={state.review}
              evidence={state.selectedEvidence}
              auditEvents={state.selectedAuditEvents}
              onNavigate={state.selectedIndex >= 0 ? state.navigate : undefined}
              navPosition={
                state.selectedIndex >= 0
                  ? { index: state.selectedIndex + 1, total: rows.length }
                  : undefined
              }
              onSelectMemory={state.open}
              onOpenResolver={
                state.conflictPartner ? () => state.setResolverOpen(true) : undefined
              }
              onMarkOutdated={state.markOutdated}
              revisions={state.selectedRevisions}
              onRestoreRevision={state.restoreRevision}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <MemoryFilterDrawer
        open={filterOpen}
        onOpenChange={setFilterOpen}
        facets={state.facets}
        filter={state.filter}
        onFilterChange={state.setFilter}
        projectNames={state.projectNames}
        sort={state.sort}
        onSortChange={state.setSort}
      />
      <MemoryConsoleDialogs state={state} />
    </main>
  )
}
