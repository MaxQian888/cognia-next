"use client"

/**
 * The `/memory` console's state and every action it can take, shared by the
 * desktop console (`MemoryConsole`, a `FeaturePageShell`) and the compact body
 * (`MemoryMobileBody`, phones, Capacitor and narrow windows).
 *
 * The two bodies used to be two programs: the desktop owned quick views,
 * facets, the inspector, review, conflicts, bulk actions and delete, while the
 * compact body was a search box over a list with three buttons per row, and
 * wrote to a different place. They now differ only in layout. Everything that
 * decides WHAT happens — which rows are shown, what a tap selects, which
 * commands run and where they land (`useMemoryCommand`, routed by data
 * ownership, never by width) — lives here once.
 *
 * Two interaction rules are owned here because both bodies must agree on them:
 *
 *  - **Archive is undoable, so it is not confirmed.** It runs at once and the
 *    toast carries an Undo that restores the rows. Confirming a reversible
 *    action trains people to click through the confirmation that matters.
 *  - **Delete is permanent, so it always is.** Row, inspector, bulk and "clear
 *    filtered" all request a delete; one confirmation (`pendingDelete`) runs it.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useLiveQueryState } from "@/hooks/ui"
import { useClientLiveQuery } from "@/hooks/data"
import { useMemoryCommand } from "@/hooks/memory/use-memory-command"
import { listMemories, listMemoryRevisions, type MemoryNamespaceTarget } from "@/lib/db/memories"
import { listMemoryAuditEvents, listMemoryEvidence } from "@/lib/db/memory-governance"
import type { ManageMemoryCommand } from "@/lib/memory/control-plane/manage"
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
import { useProjectStore } from "@/stores/project/project-store"
import type { Memory } from "@/types/memory/memory"

export const MEMORY_CONSOLE_TABS = ["app", "health", "external"] as const
export type MemoryConsoleTab = (typeof MEMORY_CONSOLE_TABS)[number]
export type MemoryConsoleDensity = "comfortable" | "compact"

export interface MemoryInspectorPatchInput {
  text?: string
  tags?: string[]
  importance?: number
}

export interface MemoryCreateInput {
  type: Memory["type"]
  text: string
  importance: number
  tags: string[]
  scope: Memory["scope"]
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
}

export interface UseMemoryConsoleOptions {
  /** Preselect this memory (`/memory?id=` deep link from chat chips). */
  initialSelectedId?: string
  /** Open filtered to one workspace (`/memory?workspace=`, ADR-0204). */
  initialProjectId?: string
}

const EMPTY_MEMORIES: Memory[] = []
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>()

export function useMemoryConsole({
  initialSelectedId,
  initialProjectId,
}: UseMemoryConsoleOptions = {}) {
  const t = useTranslations("memory.panel")
  const tBulk = useTranslations("memory.bulk")
  const { run, authority } = useMemoryCommand()

  const memoriesQuery = useLiveQueryState(() => listMemories({}), [])
  const all = memoriesQuery.data ?? EMPTY_MEMORIES

  const [tab, setTab] = useState<MemoryConsoleTab>("app")
  const [view, setView] = useState<MemoryQuickViewId>("all")
  const [filter, setFilter] = useState<MemoryFilter>(() =>
    initialProjectId ? { projectIds: [initialProjectId] } : {}
  )
  const [sort, setSort] = useState<MemorySortKey>("recent")
  const [density, setDensity] = useState<MemoryConsoleDensity>("comfortable")
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  // Opens the inspector straight into its editor (a row's "Edit" on a touch
  // layout, where the row itself has no inline editor).
  const [editRequested, setEditRequested] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(EMPTY_SELECTION)
  // Touch layouts select by long-press into an explicit mode; a pointer layout
  // always shows the checkboxes, so this only gates the compact body.
  const [selecting, setSelecting] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [resolverOpen, setResolverOpen] = useState(false)
  const [moveId, setMoveId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<readonly string[] | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)

  const deferredQuery = useDeferredValue(filter.query ?? "")

  const memoryById = useMemo(() => {
    const map = new Map<string, Memory>()
    for (const memory of all) map.set(memory.id, memory)
    return map
  }, [all])

  const viewCounts = useMemo(() => countMemoryQuickViews(all), [all])
  const insights = useMemo(() => computeMemoryCorpusInsights(all), [all])

  // The quick view owns status / pin / review; the facet filter owns type /
  // scope / provenance / tag. Splitting them is what lets the facet menu offer
  // only options that exist inside the current view.
  const viewFilter = useMemo(() => findMemoryQuickView(view).filter, [view])
  const viewRows = useMemo(
    () => filterAndSortMemories(all, { ...viewFilter, sort }),
    [all, viewFilter, sort]
  )
  const facets = useMemo(() => collectMemoryFacets(viewRows), [viewRows])
  const projects = useProjectStore((state) => state.projects)
  const projectNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const project of projects) map[project.id] = project.name
    return map
  }, [projects])

  const rows = useMemo(
    () => filterAndSortMemories(all, { ...filter, ...viewFilter, query: deferredQuery, sort }),
    [all, filter, viewFilter, deferredQuery, sort]
  )
  const activeTags = useTagSet(filter.tags)
  const archivedView = view === "archived"

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
  const selectedRevisions = useClientLiveQuery(
    () => (selectedId ? listMemoryRevisions(selectedId) : Promise.resolve([])),
    [selectedId],
    []
  )
  const selectedIndex = selectedMemory ? rows.findIndex((row) => row.id === selectedId) : -1
  const conflictPartnerId = selectedMemory?.conflictWithIds?.[0]
  const conflictPartner = conflictPartnerId ? memoryById.get(conflictPartnerId) : undefined
  const moveMemory = moveId ? memoryById.get(moveId) : undefined

  // Drop a dangling selection when the row disappears. Adjusted during render
  // (React's "adjust state while rendering" pattern) rather than in an effect,
  // and only once the store has resolved, so a deep-linked id survives the
  // first paint while the live query is still out.
  if (selectedId && all.length > 0 && !memoryById.has(selectedId)) setSelectedId(null)

  // Keep `?id=` in step with the inspector so a selection is linkable and
  // survives a refresh. `history.replaceState`, never `router.replace`: this
  // app is a static export and a route push would re-evaluate the page.
  useEffect(() => {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (url.searchParams.get("id") === selectedId) return
    if (selectedId) url.searchParams.set("id", selectedId)
    else url.searchParams.delete("id")
    window.history.replaceState(window.history.state, "", url)
  }, [selectedId])

  const open = useCallback((id: string, options?: { edit?: boolean }) => {
    setEditRequested(options?.edit === true)
    setSelectedId(id)
  }, [])
  const close = useCallback(() => {
    setEditRequested(false)
    setSelectedId(null)
  }, [])

  const navigate = useCallback(
    (delta: -1 | 1) => {
      setEditRequested(false)
      setSelectedId((prev) => {
        if (!prev) return prev
        const index = rows.findIndex((row) => row.id === prev)
        if (index < 0) return prev
        return rows[index + delta]?.id ?? prev
      })
    },
    [rows]
  )

  const forget = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids)
    setSelectedId((current) => (current && gone.has(current) ? null : current))
    setSelectedIds((prev) => {
      if (![...prev].some((id) => gone.has(id))) return prev
      return new Set([...prev].filter((id) => !gone.has(id)))
    })
  }, [])

  const toggleSelect = useCallback((id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const startSelecting = useCallback((id?: string) => {
    setSelecting(true)
    if (id) setSelectedIds((prev) => new Set(prev).add(id))
  }, [])
  const clearSelection = useCallback(() => {
    setSelectedIds(EMPTY_SELECTION)
    setSelecting(false)
  }, [])

  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  const selectAllVisible = useCallback(
    (checked: boolean) => setSelectedIds(checked ? new Set(visibleIds) : EMPTY_SELECTION),
    [visibleIds]
  )

  /**
   * Run commands together, keeping the failed rows selected for a retry and
   * the selection visible (actions disabled) until everything settles.
   * Resolves the ids whose command landed.
   */
  const runMany = useCallback(
    async (commands: Array<ManageMemoryCommand & { id: string }>): Promise<string[]> => {
      if (commands.length === 1) {
        const only = commands[0]!
        return (await run(only)) ? [only.id] : []
      }
      setBulkBusy(true)
      try {
        const results = await Promise.all(commands.map((command) => run(command)))
        const failedIds = commands.flatMap((command, index) => (results[index] ? [] : [command.id]))
        setSelectedIds(new Set(failedIds))
        if (failedIds.length === 0) setSelecting(false)
        const succeeded = commands.length - failedIds.length
        if (failedIds.length > 0) {
          toast.error(tBulk("partialFailure", { succeeded, failed: failedIds.length }))
        }
        return commands.flatMap((command, index) => (results[index] ? [command.id] : []))
      } finally {
        setBulkBusy(false)
      }
    },
    [run, tBulk]
  )

  const restore = useCallback(
    async (ids: readonly string[]) => {
      const done = await runMany(ids.map((id) => ({ kind: "restore" as const, id })))
      if (done.length > 0) toast.success(t("restoredToast", { count: done.length }))
    },
    [runMany, t]
  )

  const archive = useCallback(
    async (ids: readonly string[]) => {
      const done = await runMany(ids.map((id) => ({ kind: "invalidate" as const, id })))
      if (done.length === 0) return
      forget(done)
      toast.success(t("archivedToast", { count: done.length }), {
        action: { label: t("undo"), onClick: () => void restore(done) },
      })
    },
    [runMany, forget, restore, t]
  )

  const requestDelete = useCallback((ids: readonly string[]) => {
    if (ids.length > 0) setPendingDelete(ids)
  }, [])
  const confirmDelete = useCallback(async () => {
    const ids = pendingDelete ?? []
    setPendingDelete(null)
    if (ids.length === 0) return
    const done = await runMany(ids.map((id) => ({ kind: "delete" as const, id })))
    if (done.length === 0) return
    forget(done)
    toast.success(t("deletedToast", { count: done.length }))
  }, [pendingDelete, forget, runMany, t])

  const pin = useCallback(
    (ids: readonly string[], pinned: boolean) =>
      void runMany(ids.map((id) => ({ kind: "pin" as const, id, pinned }))),
    [runMany]
  )
  const saveText = useCallback(
    (id: string, text: string) => void run({ kind: "update", id, patch: { text } }),
    [run]
  )
  const saveInspector = useCallback(
    (id: string, patch: MemoryInspectorPatchInput) => {
      setEditRequested(false)
      void run({ kind: "update", id, patch })
    },
    [run]
  )
  const review = useCallback(
    (id: string, status: "verified" | "conflict") => void run({ kind: "review", id, status }),
    [run]
  )
  // `retrieval-feedback`, not `invalidate`: a claim that stopped being true is
  // still real history; archiving is a different intent with its own button.
  const markOutdated = useCallback(
    async (id: string) => {
      await run({ kind: "retrieval-feedback", id, verdict: "outdated" })
    },
    [run]
  )
  const restoreRevision = useCallback(
    (id: string, revisionId: string) => void run({ kind: "restore-revision", id, revisionId }),
    [run]
  )
  const relocate = useCallback(
    async (id: string, target: MemoryNamespaceTarget): Promise<boolean> => {
      const ok = await run({ kind: "relocate", id, target })
      if (ok) toast.success(t("movedToast"))
      return ok
    },
    [run, t]
  )
  const create = useCallback((input: MemoryCreateInput) => run({ kind: "create", ...input }), [run])
  const copyText = useCallback(
    (text: string) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast.success(t("copied")))
        .catch(() => toast.error(t("copyFailed")))
    },
    [t]
  )

  const toggleTag = useCallback((tag: string) => {
    setFilter((prev) => {
      const tags = prev.tags ?? []
      return {
        ...prev,
        tags: tags.includes(tag) ? tags.filter((value) => value !== tag) : [...tags, tag],
      }
    })
  }, [])
  const clearFilters = useCallback(() => {
    setFilter({})
    setView("all")
  }, [])
  const changeView = useCallback((next: MemoryQuickViewId) => {
    setView(next)
    // A selection made in one view means nothing in another, and the bulk bar
    // offers different actions there (restore in Archived, archive elsewhere).
    setSelectedIds(EMPTY_SELECTION)
    setSelecting(false)
  }, [])
  const openFromHealth = useCallback((id: string) => {
    setTab("app")
    setEditRequested(false)
    setSelectedId(id)
  }, [])

  const resolveMemory = useCallback((id: string) => memoryById.get(id), [memoryById])

  return {
    authority,
    run,
    // data
    all,
    isLoading: memoriesQuery.isLoading,
    rows,
    facets,
    viewCounts,
    insights,
    projectNames,
    activeTags,
    memoryById,
    resolveMemory,
    // navigation state
    tab,
    setTab,
    view,
    setView: changeView,
    archivedView,
    filter,
    setFilter,
    sort,
    setSort,
    density,
    setDensity,
    // inspector
    selectedId,
    selectedMemory,
    selectedIndex,
    selectedEvidence,
    selectedAuditEvents,
    selectedRevisions,
    editRequested,
    conflictPartner,
    open,
    close,
    navigate,
    openFromHealth,
    // selection
    selectedIds,
    selecting,
    startSelecting,
    toggleSelect,
    selectAllVisible,
    clearSelection,
    visibleIds,
    allVisibleSelected,
    bulkBusy,
    // dialogs
    addOpen,
    setAddOpen,
    resolverOpen,
    setResolverOpen,
    moveMemory,
    setMoveId,
    pendingDelete,
    setPendingDelete,
    confirmDelete,
    // actions
    pin,
    saveText,
    saveInspector,
    review,
    markOutdated,
    restoreRevision,
    relocate,
    archive,
    restore,
    requestDelete,
    create,
    copyText,
    toggleTag,
    clearFilters,
  }
}

export type MemoryConsoleState = ReturnType<typeof useMemoryConsole>

/** Stable `Set` for the row-level active-tag highlight. */
function useTagSet(values: readonly string[] | undefined): ReadonlySet<string> {
  const key = values?.join("\u0000") ?? ""
  return useMemo(() => new Set(key ? key.split("\u0000") : []), [key])
}
