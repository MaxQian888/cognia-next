"use client"

/**
 * `/memory` — the long-term memory workspace (ADR-0069 / ADR-0115), wide
 * layout. The compact layout is `MemoryMobileBody`; both run the same state
 * and commands (`useMemoryConsole`) and differ only in arrangement.
 *
 * This is an arrangement, not a program. It hands chrome to `FeaturePageShell`
 * + `FeaturePageHeader`, the same seam `/issues`, `/servers`, `/logs` and
 * `/scheduler` use, and draws no cards: the list is the page, the inspector is
 * a resizable pane beside it on a wide window and a sheet the selection opens
 * on a narrower one (a row tap used to select a memory and show nothing below
 * 1024px, because the overlay sheet only opened from a strip icon).
 *
 * On a paired client the store shown is the host's, synced; the header says so
 * in place of the recall chip (recall settings are the host's), and the corpus
 * readout leaves out vector coverage, which a mirror never has.
 */

import { useCallback, useEffect } from "react"
import { useTranslations } from "next-intl"
import { BrainIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { MemoryBulkToolbar } from "@/components/memory/memory-bulk-toolbar"
import { MemoryConsoleDialogs } from "@/components/memory/memory-console-dialogs"
import { MemoryInspector } from "@/components/memory/memory-inspector"
import { MemoryList } from "@/components/memory/memory-list"
import { MemoryRetrievalChip } from "@/components/memory/memory-retrieval-chip"
import { MemoryHostChip } from "@/components/memory/memory-host-chip"
import { MemoryToolbar } from "@/components/memory/memory-toolbar"
import { ExternalMemoryTab } from "@/components/memory/external/external-memory-tab"
import { MemoryHealthPanel } from "@/components/memory/memory-health-panel"
import { useMemoryLint } from "@/hooks/memory/use-memory-lint"
import { MEMORY_CONSOLE_TABS, useMemoryConsole } from "@/hooks/memory/use-memory-console"
import { isEditableTarget } from "@/lib/shortcuts/dom"
import { useGitStore } from "@/stores/git/git-store"
import { cn } from "@/lib/utils"

export interface MemoryConsoleProps {
  /** Preselect this memory's inspector (`/memory?id=` deep link from chat chips). */
  initialSelectedId?: string
  /**
   * Open filtered to one workspace's memories (`/memory?workspace=` deep link
   * from the workspace manager's coordination section, ADR-0204).
   */
  initialProjectId?: string
}

export function MemoryConsole({ initialSelectedId, initialProjectId }: MemoryConsoleProps = {}) {
  const t = useTranslations("memory.panel")
  const state = useMemoryConsole({ initialSelectedId, initialProjectId })
  const {
    tab,
    setTab,
    selectedId,
    selectedMemory,
    selectedIndex,
    rows,
    navigate,
    close,
    authority,
  } = state
  const onHost = authority === "host"

  // The branch the Source Control indicator already tracks (always mounted by
  // the status bar, so a store read). No `path`: no file is open on /memory,
  // and the inspector says "cannot tell" rather than guessing.
  const gitBranch = useGitStore((store) => store.status?.branch ?? undefined)

  const lint = useMemoryLint(state.all, tab === "health")

  // Escape closes the inspector, arrows step the selection. Scoped to "the
  // inspector is open" and skipped while an editable control has focus, the
  // guard the app-shortcut dispatcher applies.
  useEffect(() => {
    if (!selectedId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.key === "Escape") {
        close()
      } else if (event.key === "ArrowDown") {
        event.preventDefault()
        navigate(1)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        navigate(-1)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selectedId, navigate, close])

  const onPaneOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close()
    },
    [close]
  )

  const isAppTab = tab === "app"

  const header = (
    <FeaturePageHeader
      variant="management"
      testId="memory-header"
      icon={<BrainIcon />}
      title={t("title")}
      description={t("subtitle")}
      navigationPlacement="inline"
      navigation={
        <div className="flex items-center gap-1" role="tablist" aria-label={t("tabsLabel")}>
          {MEMORY_CONSOLE_TABS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              onClick={() => setTab(candidate)}
              data-testid={`memory-tab-${candidate}`}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm whitespace-nowrap",
                "motion-safe:transition-colors motion-safe:duration-150",
                tab === candidate
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              )}
            >
              {t(`tabs.${candidate}`)}
              {candidate === "app" ? (
                <Badge variant="secondary" className="h-4 px-1 text-[10px] tabular-nums">
                  {state.viewCounts.all}
                </Badge>
              ) : null}
            </button>
          ))}
        </div>
      }
      status={onHost ? <MemoryHostChip /> : <MemoryRetrievalChip />}
      summary={
        isAppTab ? (
          // Shown only with real room: at `@3xl` the identity row has nothing
          // left to give and the title would collapse first.
          <span className="hidden @5xl/feature-header:inline" data-testid="memory-summary">
            {onHost
              ? t("summaryMirror", {
                  active: state.insights.stats.active,
                  pinned: state.insights.stats.pinned,
                  conflicts: state.insights.stats.conflicts,
                })
              : t("summary", {
                  active: state.insights.stats.active,
                  pinned: state.insights.stats.pinned,
                  conflicts: state.insights.stats.conflicts,
                  coverage: Math.round(state.insights.vector.coverage * 100),
                })}
          </span>
        ) : undefined
      }
      primaryAction={
        isAppTab
          ? {
              id: "add",
              label: t("add"),
              icon: PlusIcon,
              onSelect: () => state.setAddOpen(true),
              testId: "memory-add-button",
            }
          : undefined
      }
      overflowLabel={t("moreActions")}
      overflowActions={
        isAppTab
          ? [
              {
                id: "clear-filtered",
                label: t("clearFiltered"),
                icon: Trash2Icon,
                destructive: true,
                disabled: rows.length === 0,
                onSelect: () => state.requestDelete(state.visibleIds),
                testId: "memory-clear-filtered",
              },
              {
                id: "settings",
                label: t("openSettings"),
                icon: SettingsIcon,
                href: "/settings?section=memory",
              },
            ]
          : []
      }
      controls={
        isAppTab ? (
          <MemoryToolbar
            view={state.view}
            onViewChange={state.setView}
            viewCounts={state.viewCounts}
            filter={state.filter}
            onFilterChange={state.setFilter}
            facets={state.facets}
            projectNames={state.projectNames}
            sort={state.sort}
            onSortChange={state.setSort}
            density={state.density}
            onDensityChange={state.setDensity}
          />
        ) : undefined
      }
    />
  )

  return (
    <>
      <FeaturePageShell
        storageId="memory"
        header={header}
        centerClassName="min-h-0"
        rightPane={
          isAppTab && selectedMemory
            ? {
                label: t("detailTitle"),
                content: (
                  <MemoryInspector
                    key={selectedMemory.id}
                    memory={selectedMemory}
                    resolveMemory={state.resolveMemory}
                    onClose={close}
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
                    onNavigate={selectedIndex >= 0 ? navigate : undefined}
                    navPosition={
                      selectedIndex >= 0
                        ? { index: selectedIndex + 1, total: rows.length }
                        : undefined
                    }
                    onSelectMemory={state.open}
                    onOpenResolver={
                      state.conflictPartner ? () => state.setResolverOpen(true) : undefined
                    }
                    onMarkOutdated={state.markOutdated}
                    readerContext={{ branch: gitBranch }}
                    revisions={state.selectedRevisions}
                    onRestoreRevision={state.restoreRevision}
                  />
                ),
                defaultSize: 30,
                minSize: 22,
                maxSize: 46,
                // Below `lg` the inspector is a sheet the selection opens and
                // closing it clears the selection — never a strip icon to find.
                open: true,
                onOpenChange: onPaneOpenChange,
                overlayTrigger: false,
                overlayCloseButton: false,
                mobileWidthClass: "w-full sm:max-w-md",
              }
            : undefined
        }
      >
        {isAppTab ? (
          <div className="flex h-full min-h-0 flex-col">
            {state.selectedIds.size > 0 ? (
              <MemoryBulkToolbar
                selectedCount={state.selectedIds.size}
                visibleCount={state.visibleIds.length}
                allSelected={state.allVisibleSelected}
                busy={state.bulkBusy}
                archivedView={state.archivedView}
                onToggleSelectAll={state.selectAllVisible}
                onPin={() => state.pin([...state.selectedIds], true)}
                onUnpin={() => state.pin([...state.selectedIds], false)}
                onArchive={() => void state.archive([...state.selectedIds])}
                onRestore={() => void state.restore([...state.selectedIds])}
                onDelete={() => state.requestDelete([...state.selectedIds])}
                onClear={state.clearSelection}
              />
            ) : null}
            <div className="min-h-0 flex-1">
              <MemoryList
                rows={rows}
                isLoading={state.isLoading}
                hasAnyMemories={state.all.length > 0}
                density={state.density}
                selectedId={selectedId ?? undefined}
                selectedIds={state.selectedIds}
                selectionActive
                activeTags={state.activeTags}
                onOpenDetail={state.open}
                onSelectToggle={state.toggleSelect}
                onPinToggle={(id, pinned) => state.pin([id], pinned)}
                onSave={state.saveText}
                onArchive={(id) => void state.archive([id])}
                onRestore={(id) => void state.restore([id])}
                onMove={state.setMoveId}
                onCopy={state.copyText}
                onDelete={(id) => state.requestDelete([id])}
                onTagClick={state.toggleTag}
                onClearFilters={state.clearFilters}
                onAddFirst={() => state.setAddOpen(true)}
                scrollToId={initialSelectedId}
              />
            </div>
          </div>
        ) : tab === "health" ? (
          <MemoryHealthPanel
            report={lint.report}
            loading={lint.loading}
            onRefresh={lint.refresh}
            resolveMemory={state.resolveMemory}
            onOpenMemory={state.openFromHealth}
            mirror={onHost}
          />
        ) : (
          <ExternalMemoryTab onHost={onHost} />
        )}
      </FeaturePageShell>

      <MemoryConsoleDialogs state={state} />
    </>
  )
}
