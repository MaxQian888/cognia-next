"use client"

/**
 * `/memory` — the long-term memory workspace (ADR-0069 / ADR-0115).
 *
 * This is an orchestration layer, not a layout. It owns state and mutations and
 * hands everything else to `FeaturePageShell` + `FeaturePageHeader`, the same
 * chrome `/issues`, `/servers`, `/logs` and `/scheduler` render inside.
 *
 * What that replaced: six stacked bands of chrome (a header rendered as a
 * floating card, a retrieval Card showing zeroes, a tab strip, five gradient
 * stat tiles, a `flex-wrap` row of eight filter controls, and a bulk bar that
 * pushed the list down when you ticked a checkbox) above a list left with about
 * a third of the viewport. The stat tiles are quick-view chips in the toolbar
 * now — they were filters wearing a dashboard's clothes — and the retrieval
 * panel is a header chip with a popover.
 *
 * Every mutation funnels through `runManaged` so a rejected command
 * (`{ ok: false, reason }`) surfaces a toast instead of failing silently, and a
 * `piiRedacted` result tells the user their text was rewritten before it was
 * stored rather than letting the change look lossless.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { BrainIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"
import { AddMemoryDialog, type AddMemoryInput } from "@/components/memory/add-memory-dialog"
import { MemoryBulkToolbar } from "@/components/memory/memory-bulk-toolbar"
import { MemoryConflictResolver } from "@/components/memory/memory-conflict-resolver"
import { MemoryInspector, type MemoryInspectorPatch } from "@/components/memory/memory-inspector"
import { MemoryList } from "@/components/memory/memory-list"
import { MemoryRetrievalChip } from "@/components/memory/memory-retrieval-chip"
import { MemoryToolbar, type MemoryDensity } from "@/components/memory/memory-toolbar"
import { ExternalMemoryTab } from "@/components/memory/external/external-memory-tab"
import { useLiveQueryState } from "@/hooks/ui"
import { useClientLiveQuery } from "@/hooks/data"
import { listMemories } from "@/lib/db/memories"
import { listMemoryAuditEvents, listMemoryEvidence } from "@/lib/db/memory-governance"
import { manageMemory, type ManageMemoryCommand } from "@/lib/memory/control-plane/manage"
import { computeMemoryCorpusInsights } from "@/lib/memory/insights"
import {
  collectMemoryFacets,
  countMemoryQuickViews,
  filterAndSortMemories,
  findMemoryQuickView,
  type MemoryFilter,
  type MemoryQuickViewId,
  type MemorySortKey,
} from "@/lib/memory/history-filter"
import { isEditableTarget } from "@/lib/shortcuts/dom"
import { useProjectStore } from "@/stores/project/project-store"
import { useGitStore } from "@/stores/git/git-store"
import type { Memory } from "@/types/memory/memory"
import { cn } from "@/lib/utils"

const EMPTY_MEMORIES: Memory[] = []
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>()
const TABS = ["app", "external"] as const

type MemoryTab = (typeof TABS)[number]

export interface MemoryConsoleProps {
  /** Preselect this memory's inspector (`/memory?id=` deep link from chat chips). */
  initialSelectedId?: string
}

export function MemoryConsole({ initialSelectedId }: MemoryConsoleProps = {}) {
  const t = useTranslations("memory.panel")
  const tErrors = useTranslations("memory.errors")

  const memoriesQuery = useLiveQueryState(() => listMemories({}), [])
  const all = memoriesQuery.data ?? EMPTY_MEMORIES

  const [tab, setTab] = useState<MemoryTab>("app")
  const [view, setView] = useState<MemoryQuickViewId>("all")
  const [filter, setFilter] = useState<MemoryFilter>({})
  const [sort, setSort] = useState<MemorySortKey>("recent")
  const [density, setDensity] = useState<MemoryDensity>("comfortable")
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(EMPTY_SELECTION)
  const [addOpen, setAddOpen] = useState(false)
  const [resolverOpen, setResolverOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmClearFiltered, setConfirmClearFiltered] = useState(false)

  const deferredQuery = useDeferredValue(filter.query ?? "")

  const memoryById = useMemo(() => {
    const map = new Map<string, Memory>()
    for (const memory of all) map.set(memory.id, memory)
    return map
  }, [all])

  const viewCounts = useMemo(() => countMemoryQuickViews(all), [all])
  const insights = useMemo(() => computeMemoryCorpusInsights(all), [all])

  // The quick view owns status / pin / review; the toolbar's facet filter owns
  // type / scope / provenance / tag. Splitting them is what lets the facet menu
  // offer only options that exist inside the current view.
  const viewFilter = useMemo(() => findMemoryQuickView(view).filter, [view])
  const viewRows = useMemo(
    () => filterAndSortMemories(all, { ...viewFilter, sort }),
    [all, viewFilter, sort]
  )
  const facets = useMemo(() => collectMemoryFacets(viewRows), [viewRows])
  // Workspace ids are opaque; the facet menu needs names. Read from the store
  // rather than joining Dexie: the console already holds every memory in
  // memory, and the project list is small and already loaded by the shell.
  const projects = useProjectStore((state) => state.projects)
  // The branch the Source Control indicator is already tracking — it is
  // always-mounted from the status bar, so this is a store read, not a new
  // watcher. There is deliberately no `path`: no file is open on /memory, and
  // the badge says "cannot tell" rather than guessing.
  const gitBranch = useGitStore((state) => state.status?.branch ?? undefined)
  const readerContext = useMemo(() => ({ branch: gitBranch }), [gitBranch])
  const projectNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const project of projects) map[project.id] = project.name
    return map
  }, [projects])

  const rows = useMemo(
    () =>
      filterAndSortMemories(all, {
        ...filter,
        ...viewFilter,
        query: deferredQuery,
        sort,
      }),
    [all, filter, viewFilter, deferredQuery, sort]
  )

  const activeTags = useTagSet(filter.tags)

  const selectedMemory = selectedId ? memoryById.get(selectedId) : undefined
  const selectedEvidence = useClientLiveQuery(
    () => (selectedId ? listMemoryEvidence(selectedId) : Promise.resolve([])),
    [selectedId],
    []
  )
  const selectedAuditEvents = useClientLiveQuery(
    () => (selectedId ? listMemoryAuditEvents({ memoryId: selectedId }) : Promise.resolve([])),
    [selectedId],
    []
  )
  const selectedIndex = selectedMemory ? rows.findIndex((row) => row.id === selectedId) : -1

  // Drop a dangling selection when the underlying row disappears. Adjusted
  // during render (React's documented "adjust state while rendering" pattern)
  // rather than in an effect. Gated on a resolved, non-empty store so a
  // deep-linked id survives the first paint while the live query is still out.
  if (selectedId && all.length > 0 && !memoryById.has(selectedId)) setSelectedId(null)

  // Keep `?id=` in step with the inspector so the selection is linkable and
  // survives a refresh. `history.replaceState`, never `router.replace` — this
  // app is a static export and a route push would re-evaluate the page.
  useEffect(() => {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (url.searchParams.get("id") === selectedId) return
    if (selectedId) url.searchParams.set("id", selectedId)
    else url.searchParams.delete("id")
    window.history.replaceState(window.history.state, "", url)
  }, [selectedId])

  const navigate = useCallback(
    (delta: -1 | 1) => {
      setSelectedId((prev) => {
        if (!prev) return prev
        const index = rows.findIndex((row) => row.id === prev)
        if (index < 0) return prev
        return rows[index + delta]?.id ?? prev
      })
    },
    [rows]
  )

  // Escape closes the inspector, arrows step the selection. Scoped to "the
  // inspector is open" and skipped while an editable control has focus, using
  // the same `isEditableTarget` guard the app-shortcut dispatcher applies —
  // this used to hand-roll that check and missed editor surfaces entirely.
  useEffect(() => {
    if (!selectedId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.key === "Escape") {
        setSelectedId(null)
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
  }, [selectedId, navigate])

  /**
   * Single funnel for every mutation. Returns whether the command landed, so
   * callers (the add dialog especially) can keep their UI open on failure.
   */
  const runManaged = useCallback(
    async (command: ManageMemoryCommand): Promise<boolean> => {
      try {
        const result = await manageMemory(command)
        if (!result.ok) {
          toast.error(tErrors(result.reason))
          return false
        }
        // The control plane silently rewrites text that trips the PII gate.
        // Saying so is the difference between "saved" and "saved something
        // slightly different from what you typed".
        if (result.piiRedacted) toast.warning(t("piiRedacted"))
        return true
      } catch {
        toast.error(tErrors("mutation_failed"))
        return false
      }
    },
    [t, tErrors]
  )

  const forgetId = useCallback((id: string) => {
    setSelectedId((current) => (current === id ? null : current))
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const handleOpenDetail = useCallback((id: string) => setSelectedId(id), [])
  const handleSelectToggle = useCallback((id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const handleRowPin = useCallback(
    (id: string, pinned: boolean) => {
      void runManaged({ kind: "pin", id, pinned })
    },
    [runManaged]
  )
  const handleRowSave = useCallback(
    (id: string, text: string) => {
      void runManaged({ kind: "update", id, patch: { text } })
    },
    [runManaged]
  )
  const handleArchive = useCallback(
    (id: string) => {
      void runManaged({ kind: "invalidate", id })
      forgetId(id)
    },
    [runManaged, forgetId]
  )
  const handleDelete = useCallback(
    (id: string) => {
      void runManaged({ kind: "delete", id })
      forgetId(id)
    },
    [runManaged, forgetId]
  )
  const handleInspectorSave = useCallback(
    (id: string, patch: MemoryInspectorPatch) => {
      void runManaged({ kind: "update", id, patch })
    },
    [runManaged]
  )
  const handleReview = useCallback(
    (id: string, status: "verified" | "conflict") => {
      void runManaged({ kind: "review", id, status })
    },
    [runManaged]
  )
  // Deliberately `retrieval-feedback`, not `invalidate`. A claim that stopped
  // being true is still real history — archiving it is a different intent with
  // its own button. This marks it stale so it ranks below fresher claims and
  // the re-check sweep looks at it sooner.
  const handleMarkOutdated = useCallback(
    (id: string) => runManaged({ kind: "retrieval-feedback", id, verdict: "outdated" }),
    [runManaged]
  )
  const handleTagClick = useCallback((tag: string) => {
    setFilter((prev) => {
      const tags = prev.tags ?? []
      return {
        ...prev,
        tags: tags.includes(tag) ? tags.filter((value) => value !== tag) : [...tags, tag],
      }
    })
  }, [])
  const resolveMemory = useCallback((id: string) => memoryById.get(id), [memoryById])

  const clearFilters = useCallback(() => {
    setFilter({})
    setView("all")
  }, [])

  // Bulk ops keep the selection visible (toolbar disabled) until every mutation
  // settles, so in-flight work has a pending state instead of vanishing.
  const runBulk = useCallback(
    (commands: ManageMemoryCommand[], onDone?: () => void) => {
      setBulkBusy(true)
      void Promise.all(commands.map(runManaged)).finally(() => {
        setBulkBusy(false)
        setSelectedIds(EMPTY_SELECTION)
        onDone?.()
      })
    },
    [runManaged]
  )

  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

  const handleCreate = useCallback(
    (input: AddMemoryInput) => runManaged({ kind: "create", ...input }),
    [runManaged]
  )

  const conflictPartnerId = selectedMemory?.conflictWithIds?.[0]
  const conflictPartner = conflictPartnerId ? memoryById.get(conflictPartnerId) : undefined
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
        <nav className="flex items-center gap-1" aria-label={t("title")}>
          {TABS.map((candidate) => (
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
                  {viewCounts.all}
                </Badge>
              ) : null}
            </button>
          ))}
        </nav>
      }
      status={<MemoryRetrievalChip />}
      summary={
        isAppTab ? (
          // The header shows `summary` from `@3xl` up, but at that width the
          // identity row (title + status chip + tabs + actions) has nothing
          // left to give and the `<h1>` collapses to zero. The corpus readout
          // is the least load-bearing item in the row, so it waits for real
          // room instead of taking the title's.
          <span className="hidden @5xl/feature-header:inline" data-testid="memory-summary">
            {t("summary", {
              active: insights.stats.active,
              pinned: insights.stats.pinned,
              conflicts: insights.stats.conflicts,
              coverage: Math.round(insights.vector.coverage * 100),
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
              onSelect: () => setAddOpen(true),
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
                onSelect: () => setConfirmClearFiltered(true),
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
            view={view}
            onViewChange={setView}
            viewCounts={viewCounts}
            filter={filter}
            onFilterChange={setFilter}
            facets={facets}
            projectNames={projectNames}
            sort={sort}
            onSortChange={setSort}
            density={density}
            onDensityChange={setDensity}
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
                    resolveMemory={resolveMemory}
                    onClose={() => setSelectedId(null)}
                    onSave={handleInspectorSave}
                    onPinToggle={handleRowPin}
                    onArchive={handleArchive}
                    onDelete={handleDelete}
                    onReview={handleReview}
                    evidence={selectedEvidence}
                    auditEvents={selectedAuditEvents}
                    onNavigate={selectedIndex >= 0 ? navigate : undefined}
                    navPosition={
                      selectedIndex >= 0
                        ? { index: selectedIndex + 1, total: rows.length }
                        : undefined
                    }
                    onSelectMemory={setSelectedId}
                    onOpenResolver={conflictPartner ? () => setResolverOpen(true) : undefined}
                    onMarkOutdated={handleMarkOutdated}
                    readerContext={readerContext}
                  />
                ),
                defaultSize: 30,
                minSize: 22,
                maxSize: 46,
              }
            : undefined
        }
      >
        {isAppTab ? (
          <div className="flex h-full min-h-0 flex-col">
            {selectedIds.size > 0 ? (
              <div className="shrink-0 border-b p-2">
                <MemoryBulkToolbar
                  selectedCount={selectedIds.size}
                  visibleCount={visibleIds.length}
                  allSelected={allVisibleSelected}
                  busy={bulkBusy}
                  onToggleSelectAll={(checked) =>
                    setSelectedIds(checked ? new Set(visibleIds) : EMPTY_SELECTION)
                  }
                  onPin={() =>
                    runBulk([...selectedIds].map((id) => ({ kind: "pin", id, pinned: true })))
                  }
                  onUnpin={() =>
                    runBulk([...selectedIds].map((id) => ({ kind: "pin", id, pinned: false })))
                  }
                  onArchive={() =>
                    runBulk([...selectedIds].map((id) => ({ kind: "invalidate", id })))
                  }
                  onDelete={() => {
                    const ids = [...selectedIds]
                    if (selectedId && ids.includes(selectedId)) setSelectedId(null)
                    runBulk(ids.map((id) => ({ kind: "delete", id })))
                  }}
                  onClear={() => setSelectedIds(EMPTY_SELECTION)}
                />
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <MemoryList
                rows={rows}
                isLoading={memoriesQuery.isLoading}
                hasAnyMemories={all.length > 0}
                density={density}
                selectedId={selectedId ?? undefined}
                selectedIds={selectedIds}
                selectionActive
                activeTags={activeTags}
                onOpenDetail={handleOpenDetail}
                onSelectToggle={handleSelectToggle}
                onPinToggle={handleRowPin}
                onSave={handleRowSave}
                onArchive={handleArchive}
                onDelete={handleDelete}
                onTagClick={handleTagClick}
                onClearFilters={clearFilters}
                onAddFirst={() => setAddOpen(true)}
                scrollToId={initialSelectedId}
              />
            </div>
          </div>
        ) : (
          <ExternalMemoryTab />
        )}
      </FeaturePageShell>

      <AddMemoryDialog open={addOpen} onOpenChange={setAddOpen} onCreate={handleCreate} />

      {selectedMemory && conflictPartner ? (
        <MemoryConflictResolver
          open={resolverOpen}
          onOpenChange={setResolverOpen}
          memory={selectedMemory}
          resolveMemory={resolveMemory}
          onResolved={(keptId) => setSelectedId(keptId)}
        />
      ) : null}

      <ConfirmActionDialog
        open={confirmClearFiltered}
        onOpenChange={setConfirmClearFiltered}
        title={t("clearFilteredConfirm.title", { count: rows.length })}
        description={t("clearFilteredConfirm.description")}
        confirmLabel={t("clearFilteredConfirm.confirm")}
        cancelLabel={t("clearFilteredConfirm.cancel")}
        tone="destructive"
        onConfirm={() => {
          const count = rows.length
          const ids = rows.map((row) => row.id)
          setSelectedId(null)
          runBulk(
            ids.map((id) => ({ kind: "delete", id })),
            () => toast.success(t("clearedToast", { count }))
          )
        }}
      />
    </>
  )
}

/** Stable `Set` for the row-level active-tag highlight. */
function useTagSet(values: readonly string[] | undefined): ReadonlySet<string> {
  const key = values?.join("\u0000") ?? ""
  return useMemo(() => new Set(key ? key.split("\u0000") : []), [key])
}
