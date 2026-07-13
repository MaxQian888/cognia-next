"use client"

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BrainIcon,
  SearchIcon,
  ArchiveIcon,
  NotebookPenIcon,
  ListChecksIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import type { Memory, MemoryProvenance, MemoryScope, MemoryType } from "@/types/memory/memory"
import {
  createMemory,
  hardDeleteMemories,
  hardDeleteMemory,
  listMemories,
  setMemoriesPinned,
  setMemoryPinned,
  updateMemory,
} from "@/lib/db/memories"
import {
  computeMemoryStats,
  filterAndSortMemories,
  type MemorySortKey,
} from "@/lib/memory/history-filter"
import { cn } from "@/lib/utils"
import { useMediaQuery, useResizableLayout } from "@/hooks/ui"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { StatCard } from "@/components/scheduler/stat-card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { MemoryRow } from "./memory-row"
import { MemoryDetailPanel, type MemoryDetailPatch } from "./memory-detail-panel"
import { AddMemoryDialog, type AddMemoryInput } from "./add-memory-dialog"
import { MemoryBulkToolbar } from "./memory-bulk-toolbar"
import { ExternalMemoryTab } from "./external/external-memory-tab"

const TYPE_ORDER: MemoryType[] = ["semantic", "episodic", "procedural"]
const SCOPE_OPTIONS: MemoryScope[] = ["global", "character"]
const PROVENANCE_OPTIONS: MemoryProvenance[] = [
  "user",
  "explicit",
  "inbound",
  "system",
  "external",
]

/**
 * Full-page `/memory` management panel. Lists every memory with search, type /
 * scope / provenance / tag filters, sort, per-row and bulk edit / pin / delete,
 * manual capture, and a resizable detail sidebar (desktop) / sheet (narrow)
 * that surfaces the full memory record. Composed from reused primitives over
 * the pure `filterAndSortMemories` helper and a live Dexie query.
 */
export function MemoryConsole() {
  const t = useTranslations("memory.panel")
  const tTypes = useTranslations("memory.types")
  const tScopes = useTranslations("memory.scopes")
  const tProv = useTranslations("memory.provenance")
  const all = useLiveQuery(() => listMemories({}), [], [] as Memory[])

  const [query, setQuery] = useState("")
  const [types, setTypes] = useState<Set<MemoryType>>(new Set())
  const [scopeFilter, setScopeFilter] = useState<MemoryScope | "all">("all")
  const [provenanceFilter, setProvenanceFilter] = useState<MemoryProvenance | "all">("all")
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [sort, setSort] = useState<MemorySortKey>("recent")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [addOpen, setAddOpen] = useState(false)

  const deferredQuery = useDeferredValue(query)
  const isDesktopViewport = useMediaQuery("(min-width: 1024px)")
  const resizableLayout = useResizableLayout("cognia-memory-panel-split")

  const stats = useMemo(() => computeMemoryStats(all), [all])
  const memoryById = useMemo(() => {
    const map = new Map<string, Memory>()
    for (const m of all) map.set(m.id, m)
    return map
  }, [all])

  const rows = useMemo(
    () =>
      filterAndSortMemories(all, {
        query: deferredQuery,
        types: [...types],
        scopes: scopeFilter === "all" ? undefined : [scopeFilter],
        provenances: provenanceFilter === "all" ? undefined : [provenanceFilter],
        tags: [...activeTags],
        status: showAll ? "all" : "active",
        sort,
      }),
    [all, deferredQuery, types, scopeFilter, provenanceFilter, activeTags, showAll, sort]
  )

  const hasActiveFilters =
    query.trim().length > 0 ||
    types.size > 0 ||
    scopeFilter !== "all" ||
    provenanceFilter !== "all" ||
    activeTags.size > 0

  const selectedMemory = selectedId ? memoryById.get(selectedId) : undefined
  const selectedIndex = selectedMemory ? rows.findIndex((m) => m.id === selectedId) : -1

  // Drop a dangling detail selection when the underlying row disappears.
  // Adjusted during render (React's documented "adjust state while rendering"
  // pattern) instead of in an effect, so we avoid a synchronous setState inside
  // useEffect. Nulling the id makes the guard false on the re-render, so it
  // converges after one extra pass.
  if (selectedId && !memoryById.has(selectedId)) setSelectedId(null)

  const navigate = useCallback(
    (delta: -1 | 1) => {
      setSelectedId((prev) => {
        if (!prev) return prev
        const idx = rows.findIndex((m) => m.id === prev)
        if (idx < 0) return prev
        const next = rows[idx + delta]
        return next ? next.id : prev
      })
    },
    [rows]
  )

  // Escape closes the desktop pane (the sheet closes itself); arrows step the
  // selection. Ignored while typing so edit fields keep their key semantics.
  useEffect(() => {
    if (!selectedId) return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return
      }
      if (e.key === "Escape") setSelectedId(null)
      else if (e.key === "ArrowDown") {
        e.preventDefault()
        navigate(1)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        navigate(-1)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selectedId, navigate])

  const toggleType = (type: MemoryType) =>
    setTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })

  const toggleTag = useCallback((tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }, [])

  const clearFilters = () => {
    setQuery("")
    setTypes(new Set())
    setScopeFilter("all")
    setProvenanceFilter("all")
    setActiveTags(new Set())
  }

  // Row-level handlers — stable so the memoized rows don't re-render on
  // unrelated state changes (selection, detail navigation).
  const handleOpenDetail = useCallback((id: string) => setSelectedId(id), [])
  const handleSelectToggle = useCallback((id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const handleRowPin = useCallback((id: string, pinned: boolean) => {
    void setMemoryPinned(id, pinned)
  }, [])
  const handleRowSave = useCallback((id: string, text: string) => {
    void updateMemory(id, { text, bumpVersion: true })
  }, [])
  const handleRowDelete = useCallback((id: string) => {
    void hardDeleteMemory(id)
    setSelectedId((cur) => (cur === id ? null : cur))
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // Detail-panel handlers.
  const handleDetailSave = useCallback((id: string, patch: MemoryDetailPatch) => {
    void updateMemory(id, { ...patch, bumpVersion: patch.text !== undefined })
  }, [])
  const resolveMemory = useCallback((id: string) => memoryById.get(id), [memoryById])

  // Bulk handlers.
  const visibleIds = useMemo(() => rows.map((m) => m.id), [rows])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

  const toggleSelectAll = (checked: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of visibleIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const clearSelection = () => setSelectedIds(new Set())
  const bulkPin = (pinned: boolean) => {
    void setMemoriesPinned([...selectedIds], pinned)
    clearSelection()
  }
  const bulkDelete = () => {
    const ids = [...selectedIds]
    void hardDeleteMemories(ids)
    if (selectedId && ids.includes(selectedId)) setSelectedId(null)
    clearSelection()
  }

  const handleCreate = useCallback(async (input: AddMemoryInput) => {
    await createMemory({
      scope: "global",
      type: input.type,
      text: input.text,
      importance: input.importance,
      tags: input.tags,
      provenance: "explicit",
    })
  }, [])

  const detailOpenPane = isDesktopViewport && Boolean(selectedMemory)
  const detailOpenSheet = !isDesktopViewport && Boolean(selectedMemory)

  const renderDetail = (className?: string) =>
    selectedMemory ? (
      <MemoryDetailPanel
        key={selectedMemory.id}
        memory={selectedMemory}
        resolveMemory={resolveMemory}
        onClose={() => setSelectedId(null)}
        onSave={handleDetailSave}
        onPinToggle={handleRowPin}
        onDelete={handleRowDelete}
        onNavigate={selectedIndex >= 0 ? navigate : undefined}
        navPosition={
          selectedIndex >= 0 ? { index: selectedIndex + 1, total: rows.length } : undefined
        }
        onSelectMemory={setSelectedId}
        className={className}
      />
    ) : null

  const renderList = () => (
    <div
      className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pr-1"
      data-testid="memory-list"
    >
      {rows.length === 0 ? (
        hasActiveFilters ? (
          <Empty data-testid="memory-empty-filtered">
            <EmptyMedia variant="icon">
              <SearchIcon className="size-6" />
            </EmptyMedia>
            <EmptyTitle>{t("noResults.title")}</EmptyTitle>
            <EmptyDescription>{t("noResults.description")}</EmptyDescription>
            <Button size="sm" variant="outline" className="mt-2" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          </Empty>
        ) : (
          <Empty>
            <EmptyMedia variant="icon">
              <BrainIcon className="size-6" />
            </EmptyMedia>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.description")}</EmptyDescription>
            <Button size="sm" className="mt-2" onClick={() => setAddOpen(true)}>
              <PlusIcon className="size-4" />
              {t("addFirst")}
            </Button>
          </Empty>
        )
      ) : (
        rows.map((m) => (
          <MemoryRow
            key={m.id}
            memory={m}
            selectable
            selected={selectedIds.has(m.id)}
            active={m.id === selectedId}
            activeTags={activeTags}
            onOpenDetail={handleOpenDetail}
            onSelectToggle={handleSelectToggle}
            onTagClick={toggleTag}
            onPinToggle={handleRowPin}
            onSave={handleRowSave}
            onDelete={handleRowDelete}
          />
        ))
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
          <BrainIcon className="size-5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
      </header>

      <Tabs defaultValue="app" className="flex min-h-0 flex-1 flex-col gap-4">
        <TabsList>
          <TabsTrigger value="app">{t("tabs.app")}</TabsTrigger>
          <TabsTrigger value="external">{t("tabs.external")}</TabsTrigger>
        </TabsList>

        <TabsContent value="app" className="flex min-h-0 flex-1 flex-col gap-4">
          {/* Stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label={t("stats.active")}
              value={stats.active}
              icon={<BrainIcon className="size-4" />}
              accentGradient="from-violet-500 to-purple-400"
              iconBgClassName="bg-violet-500/15 text-violet-500"
              testid="memory-stat-active"
            />
            <StatCard
              label={tTypes("semantic")}
              value={stats.byType.semantic}
              icon={<NotebookPenIcon className="size-4" />}
              accentGradient="from-sky-500 to-cyan-400"
              iconBgClassName="bg-sky-500/15 text-sky-500"
            />
            <StatCard
              label={tTypes("episodic")}
              value={stats.byType.episodic}
              icon={<ListChecksIcon className="size-4" />}
              accentGradient="from-emerald-500 to-green-400"
              iconBgClassName="bg-emerald-500/15 text-emerald-500"
            />
            <StatCard
              label={tTypes("procedural")}
              value={stats.byType.procedural}
              icon={<ArchiveIcon className="size-4" />}
              accentGradient="from-amber-500 to-orange-400"
              iconBgClassName="bg-amber-500/15 text-amber-500"
            />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t("searchLabel")}
                placeholder={t("searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="flex items-center gap-1" data-testid="memory-type-filters">
              {TYPE_ORDER.map((type) => (
                <Button
                  key={type}
                  size="sm"
                  variant={types.has(type) ? "default" : "outline"}
                  aria-pressed={types.has(type)}
                  onClick={() => toggleType(type)}
                >
                  {tTypes(type)}
                </Button>
              ))}
            </div>
            <Select
              value={scopeFilter}
              onValueChange={(v) => setScopeFilter(v as MemoryScope | "all")}
            >
              <SelectTrigger className="w-32" aria-label={t("scopeLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tScopes("all")}</SelectItem>
                {SCOPE_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {tScopes(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={provenanceFilter}
              onValueChange={(v) => setProvenanceFilter(v as MemoryProvenance | "all")}
            >
              <SelectTrigger className="w-32" aria-label={t("provenanceLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tProv("all")}</SelectItem>
                {PROVENANCE_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {tProv(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as MemorySortKey)}>
              <SelectTrigger className="w-36" aria-label={t("sortLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">{t("sort.recent")}</SelectItem>
                <SelectItem value="created">{t("sort.created")}</SelectItem>
                <SelectItem value="importance">{t("sort.importance")}</SelectItem>
                <SelectItem value="accessed">{t("sort.accessed")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant={showAll ? "default" : "outline"}
              aria-pressed={showAll}
              onClick={() => setShowAll((v) => !v)}
            >
              {t("showInvalidated")}
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)} data-testid="memory-add-button">
              <PlusIcon className="size-4" />
              {t("add")}
            </Button>
          </div>

          {/* Active tag filters */}
          {activeTags.size > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="memory-active-tags">
              <span className="text-xs text-muted-foreground">{t("tagFilterLabel")}</span>
              {[...activeTags].map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
                >
                  #{tag}
                  <XIcon className="size-3" />
                </button>
              ))}
              <button
                type="button"
                onClick={() => setActiveTags(new Set())}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {t("clearTags")}
              </button>
            </div>
          )}

          {/* Bulk toolbar */}
          {selectedIds.size > 0 && (
            <MemoryBulkToolbar
              selectedCount={selectedIds.size}
              visibleCount={visibleIds.length}
              allSelected={allVisibleSelected}
              onToggleSelectAll={toggleSelectAll}
              onPin={() => bulkPin(true)}
              onUnpin={() => bulkPin(false)}
              onDelete={bulkDelete}
              onClear={clearSelection}
            />
          )}

          {/* List + detail */}
          <div className="flex min-h-0 flex-1" data-testid="memory-content">
            {isDesktopViewport ? (
              <ResizablePanelGroup
                orientation="horizontal"
                className="flex-1"
                defaultLayout={resizableLayout.defaultLayout}
                onLayoutChanged={(layout) => {
                  if (Object.keys(layout).length > 1) resizableLayout.onLayoutChanged(layout)
                }}
              >
                <ResizablePanel id="memory-list-pane" defaultSize="65%" minSize="45%">
                  {renderList()}
                </ResizablePanel>
                {detailOpenPane && (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                      id="memory-detail-pane"
                      defaultSize="35%"
                      minSize="24%"
                      maxSize="55%"
                    >
                      {renderDetail(cn("h-full rounded-lg border border-border/50"))}
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            ) : (
              renderList()
            )}
          </div>
        </TabsContent>

        <TabsContent value="external" className="flex min-h-0 flex-1 flex-col">
          <ExternalMemoryTab />
        </TabsContent>
      </Tabs>

      {/* Narrow-viewport detail sheet */}
      {!isDesktopViewport && (
        <Sheet
          open={detailOpenSheet}
          onOpenChange={(open) => {
            if (!open) setSelectedId(null)
          }}
        >
          <SheetContent
            side="bottom"
            className="flex h-[85vh] flex-col p-0"
            data-testid="memory-detail-sheet"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t("detailTitle")}</SheetTitle>
              <SheetDescription>{t("detailTitle")}</SheetDescription>
            </SheetHeader>
            {renderDetail("flex-1 border-0")}
          </SheetContent>
        </Sheet>
      )}

      <AddMemoryDialog open={addOpen} onOpenChange={setAddOpen} onCreate={handleCreate} />
    </div>
  )
}
