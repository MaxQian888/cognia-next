"use client"

/**
 * Scheduler Page
 * Main page for managing scheduled tasks — SidebarProvider Master-Detail layout.
 */

import { useState, useCallback, useMemo, useEffect } from "react"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useScheduler, useSystemScheduler } from "@/hooks/scheduler"
import { useUnifiedScheduledItems } from "@/hooks/scheduler/use-unified-items"
import { bootstrapSchedulerSources } from "@/lib/scheduler/sources/bootstrap"
import { consumeScheduledTaskDraft } from "@/lib/scheduler/task-draft-handoff"
import { getSchedulerSourceRegistry } from "@/lib/scheduler/sources/registry"
import { getSchedulerDataSource } from "@/lib/scheduler/scheduler-data-source"
import { useSchedulerHostTarget } from "@/hooks/scheduler/use-scheduler-host-target"
import { workspaceScopeForSchedulerHost } from "@/lib/scheduler/task-workspace-binding"
import { useBreakpoint } from "@/hooks/ui"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import {
  BackfillDialog,
  SchedulerSidebar,
  SchedulerSidebarContent,
  SchedulerShell,
  SchedulerDashboardView,
  SchedulerSkeleton,
  SchedulerErrorBoundary,
  TaskDetailView,
  TaskTemplateGallery,
  ExportTasksDialog,
  ImportTasksDialog,
  SystemTaskInspectSheet,
  SchedulerContentHeader,
  SchedulerMobileDetailView,
  SchedulerDialogs,
} from "@/components/scheduler"
import { UnifiedTaskDetailView } from "@/components/scheduler/unified-task-detail-view"
import { SchedulerHostBar } from "@/components/scheduler/scheduler-host-bar"
import { RunDetailSheet } from "@/components/scheduler/run-detail-sheet"
import { SchedulerBulkToolbar } from "@/components/scheduler/scheduler-bulk-toolbar"
import { SchedulerUpcomingRail } from "@/components/scheduler/scheduler-upcoming-rail"
import { QuickWorkflowTriggerDialog } from "@/components/scheduler/dialogs/quick-workflow-trigger-dialog"
import { BackupScheduleDialog } from "@/components/scheduler/backup-schedule-dialog"
import { TaskDependencyDialog } from "@/components/scheduler/task-dependency-dialog"
import { DeleteItemDialog } from "@/components/scheduler/delete-item-dialog"
import { toUnifiedFromTaskExecution } from "@/hooks/scheduler/use-unified-recent-runs"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { deriveUnifiedFacets, type UnifiedStatusFilter } from "@/lib/scheduler/unified-filter"
import { useUnifiedRecentRuns } from "@/hooks/scheduler/use-unified-recent-runs"
import type { CreateScheduledTaskInput, CreateSystemTaskInput } from "@/types/scheduler"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

export default function SchedulerPage() {
  const router = useRouter()
  const t = useTranslations("scheduler")
  // The phone-shaped scheduler already exists, at `/me/scheduler`: host bar,
  // stat strip, search, both chip rows, the list, the detail view and the
  // create / edit sheets. What was missing is that nothing sent a narrow
  // viewport there, so `/scheduler` from the rail or a deep link rendered this
  // master-detail layout at 375px. `/me/scheduler` bounces the other way on a
  // wide layout, so the two are a mutually exclusive pair rather than a loop.
  //
  // A redirect rather than a second compact body. One scheduler with two
  // entrances beats two schedulers that will disagree about filters within a
  // release.
  const compact = useCompactLayout()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])
  useEffect(() => {
    if (!mounted || !compact) return
    router.replace("/me/scheduler")
  }, [compact, mounted, router])
  const schedulerHost = getSchedulerDataSource().host
  // Reactive view of the same choice. `getSchedulerDataSource()` is read once
  // per render and does not re-run when the host bar flips the target, which
  // is fine for the promotion copy below but not for what the list shows.
  const { target: schedulerHostTarget } = useSchedulerHostTarget()
  const {
    tasks,
    executions,
    selectedTask,
    schedulerStatus,
    filter,
    isLoading,
    isInitialized,
    createTask,
    updateTask,
    deleteTask,
    pauseTask,
    resumeTask,
    promoteTask,
    recordPromotion,
    unpromoteTask,
    runTaskNow,
    backfillTask,
    selectTask,
    setFilter,
    clearFilter,
    refresh,
    cleanupOldExecutions,
    cloneTask,
    cancelPluginExecution,
    getActivePluginCount: _getActivePluginCount,
    isPluginExecutionActive,
    hasMoreExecutions,
    loadMoreExecutions,
  } = useScheduler()

  // Multi-select state (unified-item ids) lives in the scheduler store so it
  // persists across the dashboard ↔ detail transitions during a single bulk
  // session. The hover-revealed checkbox on each `UnifiedTaskSidebarItem`
  // toggles membership; the `SchedulerBulkToolbar` consumes the resolved set.
  const multiSelection = useSchedulerStore((s) => s.multiSelection)
  const toggleMultiSelection = useSchedulerStore((s) => s.toggleMultiSelection)
  const clearMultiSelection = useSchedulerStore((s) => s.clearMultiSelection)

  const {
    capabilities,
    tasks: systemTasks,
    pendingConfirmation,
    refresh: refreshSystem,
    createTask: createSystemTask,
    updateTask: updateSystemTask,
    deleteTask: deleteSystemTask,
    confirmPending,
    confirmTask: confirmSystemTask,
    cancelPending,
    validateTask,
    requestElevation,
    clearError: clearSystemError,
  } = useSystemScheduler()

  // OS promotion (wake + delegate). A promotion that needs an OS confirmation
  // (elevation / risk) parks here until the shared confirmation dialog resolves;
  // the created OS task is then recorded on the app task.
  const [pendingPromotion, setPendingPromotion] = useState<{
    taskId: string
    token: string
  } | null>(null)
  const promotionAvailable = schedulerHost === "local" && capabilities?.available === true
  const promotionUnavailableReason =
    schedulerHost !== "local"
      ? t("promote.unavailableRemote")
      : capabilities?.available
        ? undefined
        : t("promote.unavailableHost")

  // Bootstrap the source registry exactly once per process. The bootstrap
  // function is idempotent and registers every source against the singleton
  // registry that `useUnifiedScheduledItems` consumes.
  useEffect(() => {
    bootstrapSchedulerSources()
  }, [])
  const {
    items: unifiedItems,
    statistics: unifiedStatistics,
    errors: unifiedSourceErrors,
  } = useUnifiedScheduledItems({
    registry: getSchedulerSourceRegistry(),
  })
  // Cross-source run history — feeds the overview's 7-day chart. The chart used
  // to read the app-only `recentExecutions` slice while every number beside it
  // counted all six sources.
  const { runs: unifiedRecentRuns } = useUnifiedRecentRuns({ limit: 200 })

  // --- New layout state ---
  const [mobileView, setMobileView] = useState<"list" | "detail">("list")
  // Filter state lives here because it drives three things at once: the rows
  // the sidebar renders, the facet counts on its controls, and the keyboard
  // cursor below. All four axes narrow the SAME unified list — before this,
  // search and status quietly filtered an app-only array that was never
  // rendered, so typing in the search box changed nothing on screen.
  const [searchQuery, setSearchQuery] = useState(filter.search || "")
  const [statusFilter, setStatusFilter] = useState<UnifiedStatusFilter>("all")
  const [selectedKinds, setSelectedKinds] = useState<ReadonlySet<ScheduledItemKind>>(
    () => new Set()
  )
  const [loopOnly, setLoopOnly] = useState(false)
  // Shared three-tier breakpoint (matches the Inbox shell): mobile < 768px.
  const breakpoint = useBreakpoint()
  const isMobile = breakpoint === "mobile"
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const prefersReducedMotion = useReducedMotion()

  // --- Dialog / sheet state ---
  const [showCreateSheet, setShowCreateSheet] = useState(false)
  // A draft handed over by another surface (the composer's "schedule this"
  // suggestion) opens the create sheet pre-filled on the next mount.
  const [createDraft, setCreateDraft] = useState<{
    input: Partial<CreateScheduledTaskInput>
    summary?: string
  } | null>(null)

  // Pick up a staged draft exactly once. `consumeScheduledTaskDraft` clears
  // the stash itself, so StrictMode's replayed effect finds nothing to reopen.
  // The state write is deferred by a microtask: a synchronous setState in an
  // effect body cascades an extra render, which `react-hooks/set-state-in-effect`
  // rightly refuses. StrictMode replays effects on the same instance, so the
  // deferred write still lands.
  useEffect(() => {
    const handed = consumeScheduledTaskDraft()
    if (!handed) return
    queueMicrotask(() => {
      setCreateDraft(handed)
      setShowCreateSheet(true)
    })
  }, [])

  const [showEditSheet, setShowEditSheet] = useState(false)
  // One confirmation for every destructive delete on this page. The list rows
  // used to call the source adapter straight from the hover menu — no dialog,
  // no undo — while the detail pane asked first. Now both routes land here.
  const [pendingDelete, setPendingDelete] = useState<UnifiedScheduledItem | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showSystemCreateSheet, setShowSystemCreateSheet] = useState(false)
  const [showSystemEditSheet, setShowSystemEditSheet] = useState(false)
  const [systemDeleteTaskId, setSystemDeleteTaskId] = useState<string | null>(null)
  const [systemEditTaskId, setSystemEditTaskId] = useState<string | null>(null)
  const [systemSubmitting, setSystemSubmitting] = useState(false)
  const [showAdminDialog, setShowAdminDialog] = useState(false)
  const [inspectTaskId, setInspectTaskId] = useState<string | null>(null)
  const [showTemplateGallery, setShowTemplateGallery] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  // Phase 8 additions: unified-detail / run-detail / quick-create dialogs
  const [selectedUnifiedItem, setSelectedUnifiedItem] = useState<UnifiedScheduledItem | null>(null)
  const [selectedRun, setSelectedRun] = useState<UnifiedExecutionRun | null>(null)
  const [showQuickWorkflowDialog, setShowQuickWorkflowDialog] = useState(false)
  const [showBackupDialog, setShowBackupDialog] = useState(false)
  const [showDependencyDialog, setShowDependencyDialog] = useState(false)
  const [showBackfillDialog, setShowBackfillDialog] = useState(false)

  // Derived
  const inspectTask = useMemo(
    () => systemTasks.find((task) => task.id === inspectTaskId) ?? null,
    [systemTasks, inspectTaskId]
  )
  const selectedSystemTask = useMemo(
    () => systemTasks.find((task) => task.id === systemEditTaskId) || null,
    [systemTasks, systemEditTaskId]
  )

  // The single filtering pass for the whole page: the rows the sidebar renders
  // AND the facet counts on its controls, so a control can never advertise a
  // count the list does not contain.
  // Scoped to the workspace on screen. A schedule belongs to the work it was set
  // up for, and a list mixing five repositories' schedules cannot be
  // maintained; an UNATTRIBUTED row (no workspace — one written before
  // scheduler v5, a backup, a system task) shows everywhere, because hiding it
  // would make it invisible in every workspace at once.
  const localProjectId = useProjectStore((s) => s.activeProjectId)
  // One rule, shared with `/me/scheduler`: a local workspace id names nothing
  // on a paired host. See `workspaceScopeForSchedulerHost`.
  const workspaceScope = workspaceScopeForSchedulerHost(schedulerHostTarget, localProjectId)

  const facets = useMemo(
    () =>
      deriveUnifiedFacets(unifiedItems, {
        search: searchQuery,
        status: statusFilter,
        kinds: selectedKinds,
        loopOnly,
        projectId: workspaceScope,
      }),
    [unifiedItems, searchQuery, statusFilter, selectedKinds, loopOnly, workspaceScope]
  )
  const visibleItems = facets.visibleItems

  const toggleKindFilter = useCallback((kind: ScheduledItemKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }, [])

  const clearKindFilters = useCallback(() => {
    setSelectedKinds(new Set())
    setLoopOnly(false)
  }, [])

  /** Resets every axis, search included — the empty state's "start over". */
  const resetFilters = useCallback(() => {
    setSearchQuery("")
    setStatusFilter("all")
    setSelectedKinds(new Set())
    setLoopOnly(false)
  }, [])

  // Mirror the query into the app-scheduler store so its own `listTasks(filter)`
  // reads stay consistent with what the user typed. The rendered list is driven
  // by `facets` above, not by this.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchQuery.trim()) {
        setFilter({ search: searchQuery.trim() })
      } else if (filter.search) {
        clearFilter()
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchQuery, setFilter, clearFilter, filter.search])

  // Reset highlighted index when filter or search query changes — adjust state
  // during render based on the previous value (React's recommended pattern
  // for derived resets).
  const filterKey = `${statusFilter}|${searchQuery}|${loopOnly}|${[...selectedKinds].sort().join(",")}`
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey)
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey)
    setHighlightedIndex(-1)
  }

  // --- Handlers ---

  const handleSelectTask = useCallback(
    (taskId: string | null) => {
      selectTask(taskId)
      if (taskId && isMobile) {
        setMobileView("detail")
      }
    },
    [selectTask, isMobile]
  )

  const handleCleanup = useCallback(async () => {
    // The overview's chart and recent-runs list poll `useUnifiedRecentRuns`,
    // so they pick the deletion up on their own — no app-only reload needed.
    await cleanupOldExecutions(30)
  }, [cleanupOldExecutions])

  const handleCreateTask = useCallback(
    async (input: CreateScheduledTaskInput) => {
      setIsSubmitting(true)
      try {
        const created = await createTask(input)
        if (!created) {
          // `createTask` answers `null` for a refusal as well as a failure, and
          // the sheet used to close either way: a task the permission policy
          // turned down simply vanished with no row and no message. Keep the
          // sheet open so the user's input survives, and say why.
          toast.error(useSchedulerStore.getState().error ?? t("createTaskFailed"))
          return
        }
        setShowCreateSheet(false)
      } finally {
        setIsSubmitting(false)
      }
    },
    [createTask, t]
  )

  const handleCreateSystemTask = useCallback(
    async (input: CreateSystemTaskInput) => {
      setSystemSubmitting(true)
      clearSystemError()
      try {
        const validation = await validateTask(input)
        if (!validation.valid) {
          clearSystemError()
          return
        }
        const response = await createSystemTask(input)
        if (response.status === "success") {
          setShowSystemCreateSheet(false)
        } else if (
          response.status === "error" &&
          response.message.toLowerCase().includes("administrator")
        ) {
          setShowAdminDialog(true)
        }
      } finally {
        setSystemSubmitting(false)
      }
    },
    [createSystemTask, clearSystemError, validateTask]
  )

  const handleEditTask = useCallback(
    async (input: CreateScheduledTaskInput) => {
      if (!selectedTask) return
      setIsSubmitting(true)
      try {
        await updateTask(selectedTask.id, {
          name: input.name,
          description: input.description,
          trigger: input.trigger,
          payload: input.payload,
          notification: input.notification,
          config: input.config,
          tags: input.tags,
          // null clears a previously-set end bound; undefined would leave it.
          endAt: input.endAt ?? null,
          onSuccessTaskIds: input.onSuccessTaskIds ?? [],
          onFailureTaskIds: input.onFailureTaskIds ?? [],
        })
        setShowEditSheet(false)
      } finally {
        setIsSubmitting(false)
      }
    },
    [selectedTask, updateTask]
  )

  const handleEditSystemTask = useCallback(
    async (input: CreateSystemTaskInput) => {
      if (!selectedSystemTask) return
      setSystemSubmitting(true)
      clearSystemError()
      try {
        const validation = await validateTask(input)
        if (!validation.valid) {
          clearSystemError()
          return
        }
        const response = await updateSystemTask(selectedSystemTask.id, input)
        if (response.status === "success") {
          setShowSystemEditSheet(false)
          setSystemEditTaskId(null)
        } else if (
          response.status === "error" &&
          response.message.toLowerCase().includes("administrator")
        ) {
          setShowAdminDialog(true)
        }
      } finally {
        setSystemSubmitting(false)
      }
    },
    [selectedSystemTask, updateSystemTask, clearSystemError, validateTask]
  )

  /**
   * Ask before deleting an app task addressed by its raw id — the detail pane
   * and the keyboard shortcut still speak that language. Plugin-scheduler rows
   * share the app store's table, so both kinds are candidates.
   */
  const requestDeleteTask = useCallback(
    (taskId: string) => {
      const item = unifiedItems.find(
        (candidate) =>
          candidate.sourceId === taskId && (candidate.kind === "app" || candidate.kind === "plugin")
      )
      if (item) setPendingDelete(item)
    },
    [unifiedItems]
  )

  const handleDeleteConfirm = useCallback(async () => {
    const item = pendingDelete
    if (!item) return
    setPendingDelete(null)
    if (item.kind === "app" || item.kind === "plugin") {
      // Go through the store so the selection and the cached slices are
      // reconciled, not just the Dexie row.
      await deleteTask(item.sourceId)
      return
    }
    const source = getSchedulerSourceRegistry().getSource(item.kind)
    await source?.delete(item.sourceId)
  }, [pendingDelete, deleteTask])

  const handleSystemDeleteConfirm = useCallback(async () => {
    if (systemDeleteTaskId) {
      await deleteSystemTask(systemDeleteTaskId)
      setSystemDeleteTaskId(null)
    }
  }, [systemDeleteTaskId, deleteSystemTask])

  const handlePause = useCallback(
    async (taskId: string) => {
      await pauseTask(taskId)
    },
    [pauseTask]
  )

  const handleResume = useCallback(
    async (taskId: string) => {
      await resumeTask(taskId)
    },
    [resumeTask]
  )

  const handleRunNow = useCallback(
    async (taskId: string) => {
      await runTaskNow(taskId)
    },
    [runTaskNow]
  )

  const handleCloneTask = useCallback(
    async (taskId: string) => {
      const clone = await cloneTask(taskId)
      if (!clone) {
        toast.error(t("cloneFailed"))
        return
      }
      // Land on the copy so the very next thing the user does is edit it.
      selectTask(clone.id)
      toast.success(t("cloneSuccess", { name: clone.name }))
    },
    [cloneTask, selectTask, t]
  )

  const handlePromote = useCallback(
    async (taskId: string) => {
      const result = await promoteTask(taskId)
      switch (result.status) {
        case "promoted":
          toast.success(t("promote.success"))
          break
        case "confirmation_required":
          // The OS backend wants an explicit confirmation; the shared
          // pending-confirmation dialog takes over and `handleConfirmPending`
          // records the promotion once the OS task exists.
          setPendingPromotion({ taskId, token: result.token })
          await refreshSystem()
          break
        case "not_promotable":
          toast.error(t("promote.notPromotable"), { description: result.reason })
          break
        case "unavailable":
          toast.error(t("promote.unavailableHost"), { description: result.reason })
          break
        default:
          toast.error(t("promote.failed"), { description: result.reason })
      }
    },
    [promoteTask, refreshSystem, t]
  )

  const handleUnpromote = useCallback(
    async (taskId: string) => {
      const ok = await unpromoteTask(taskId)
      if (ok) toast.success(t("promote.removed"))
      else toast.error(t("promote.removeFailed"))
    },
    [unpromoteTask, t]
  )

  const handleConfirmPending = useCallback(async () => {
    if (!pendingPromotion) {
      await confirmPending()
      return
    }
    const confirmationId = pendingConfirmation?.confirmation_id || pendingConfirmation?.task_id
    if (!confirmationId) return
    const created = await confirmSystemTask(confirmationId)
    const parked = pendingPromotion
    setPendingPromotion(null)
    if (created) {
      const ok = await recordPromotion(parked.taskId, {
        systemTaskId: created.id,
        token: parked.token,
        backend: capabilities?.backend,
      })
      if (ok) toast.success(t("promote.success"))
      else toast.error(t("promote.failed"))
    } else {
      toast.error(t("promote.failed"))
    }
  }, [
    pendingPromotion,
    pendingConfirmation,
    confirmPending,
    confirmSystemTask,
    recordPromotion,
    capabilities?.backend,
    t,
  ])

  const handleTemplateSelect = useCallback(
    async (input: CreateScheduledTaskInput) => {
      setIsSubmitting(true)
      try {
        const created = await createTask(input)
        if (!created) toast.error(useSchedulerStore.getState().error ?? t("createTaskFailed"))
      } finally {
        setIsSubmitting(false)
      }
    },
    [createTask, t]
  )

  const handleRequestElevation = useCallback(async () => {
    setSystemSubmitting(true)
    await requestElevation()
    setSystemSubmitting(false)
    setShowAdminDialog(false)
    refreshSystem()
  }, [requestElevation, refreshSystem])

  const handleCreateClick = useCallback(() => {
    setShowCreateSheet(true)
  }, [])

  const handleRefresh = useCallback(() => {
    refresh()
    refreshSystem()
  }, [refresh, refreshSystem])

  // Dispatch unified actions to the right adapter based on item.kind. The
  // registry holds one source per kind; each source already knows how to
  // pause/resume/run/delete its native rows. Memoized so the memoized sidebar
  // rows keep referentially-stable handlers across page re-renders.
  const unifiedActions = useMemo(() => {
    // Every one of these can genuinely fail — a paired host that stopped
    // answering, an OS task the scheduler refuses, a source whose backend is
    // gone. They used to be fired as bare floating promises, so the row simply
    // did not change and the user was told nothing.
    const dispatch = (action: "runNow" | "pause" | "resume") => (item: UnifiedScheduledItem) => {
      const source = getSchedulerSourceRegistry().getSource(item.kind)
      if (!source) {
        toast.error(t("actionFailed", { name: item.name }))
        return
      }
      void source[action](item.sourceId).catch((error: unknown) => {
        toast.error(t("actionFailed", { name: item.name }), {
          description: error instanceof Error ? error.message : String(error),
        })
      })
    }
    return {
      runNow: dispatch("runNow"),
      pause: dispatch("pause"),
      resume: dispatch("resume"),
      // Deletes are irreversible: park the item and let the shared
      // confirmation dialog dispatch it.
      delete: (item: UnifiedScheduledItem) => setPendingDelete(item),
    }
    // `t` is `useMemo`-stable inside use-intl (it only changes when the locale
    // or the message bundle does), so depending on it does not defeat the
    // `React.memo` on the sidebar rows these handlers are passed to.
  }, [t])

  const handleSelectUnifiedItem = useCallback(
    (item: UnifiedScheduledItem) => {
      // Render the unified detail view in-place. App-kind items route
      // through the dedicated TaskDetailView via the orchestrator.
      if (item.kind === "app") {
        handleSelectTask(item.sourceId)
        setSelectedUnifiedItem(null)
      } else if (item.kind === "system") {
        setInspectTaskId(item.sourceId)
        setSelectedUnifiedItem(null)
      } else {
        selectTask(null)
        setSelectedUnifiedItem(item)
      }
    },
    [handleSelectTask, selectTask]
  )

  /**
   * Select by `unifiedId` — what the overview's upcoming rows, the calendar,
   * and the agenda hand back. Unknown ids are ignored rather than clearing the
   * pane (a projected run can outlive the item that produced it).
   */
  const handleSelectUnifiedId = useCallback(
    (unifiedId: string) => {
      const item = unifiedItems.find((candidate) => candidate.unifiedId === unifiedId)
      if (item) handleSelectUnifiedItem(item)
    },
    [unifiedItems, handleSelectUnifiedItem]
  )

  /**
   * `unifiedId` of whatever the detail pane is showing, so the sidebar can mark
   * the row regardless of which of the three detail surfaces owns it.
   */
  const selectedUnifiedId = selectedTask
    ? `app:${selectedTask.id}`
    : selectedUnifiedItem
      ? selectedUnifiedItem.unifiedId
      : inspectTaskId
        ? `system:${inspectTaskId}`
        : null

  // All three detail surfaces, matching `selectedUnifiedId` above — a system
  // task routes through `inspectTaskId` and clears the other two, so leaving it
  // out marked the sidebar row selected while the rail (the context strip that
  // exists precisely for "an item has taken the pane over") stayed hidden.
  const isDetailOpen = Boolean(selectedTask || selectedUnifiedItem || inspectTaskId)

  /** The row the keyboard cursor sits on, addressed the way the list is. */
  const highlightedUnifiedId =
    highlightedIndex >= 0 && highlightedIndex < visibleItems.length
      ? visibleItems[highlightedIndex].unifiedId
      : null

  /** Pin a kind from the overview's kind rail. */
  const handleSelectKindFromOverview = useCallback(
    (kind: ScheduledItemKind) => toggleKindFilter(kind),
    [toggleKindFilter]
  )

  const handleToggleUnifiedSelection = useCallback(
    (item: UnifiedScheduledItem) => toggleMultiSelection(item.unifiedId),
    [toggleMultiSelection]
  )

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        setHighlightedIndex((prev) => Math.min(prev + 1, visibleItems.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setHighlightedIndex((prev) => Math.max(prev - 1, 0))
      } else if (
        e.key === "Enter" &&
        highlightedIndex >= 0 &&
        highlightedIndex < visibleItems.length
      ) {
        e.preventDefault()
        // The cursor walks the rendered list, whatever kind each row is — it
        // used to walk an app-only array while the list showed all six sources,
        // so Enter opened a different row than the one highlighted.
        handleSelectUnifiedItem(visibleItems[highlightedIndex])
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedTask) {
        e.preventDefault()
        requestDeleteTask(selectedTask.id)
      } else if (e.key === "n" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        handleCreateClick()
      } else if (e.key === "r" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        handleRefresh()
      } else if (e.key === "Escape") {
        setShowCreateSheet(false)
        setShowEditSheet(false)
        setShowSystemCreateSheet(false)
        setShowSystemEditSheet(false)
        if (selectedTask) {
          selectTask(null)
          if (isMobile) setMobileView("list")
        }
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [
    handleCreateClick,
    handleRefresh,
    handleSelectUnifiedItem,
    requestDeleteTask,
    selectedTask,
    selectTask,
    isMobile,
    visibleItems,
    highlightedIndex,
  ])

  // Loading state — show layout-matching skeleton instead of a bare spinner so
  // the user perceives the page shape immediately.
  // Nothing of the desktop layout paints while the redirect is in flight. The
  // skeleton rather than `null` so a slow route change does not flash an empty
  // frame, and it is the same skeleton this page shows before it initialises.
  if (compact) {
    return <SchedulerSkeleton />
  }

  if (!isInitialized) {
    return <SchedulerSkeleton />
  }

  const renderSidebar = (variant: "chrome" | "content") => {
    const SidebarComponent = variant === "chrome" ? SchedulerSidebar : SchedulerSidebarContent
    return (
      <SidebarComponent
        items={unifiedItems}
        facets={facets}
        sourceErrors={unifiedSourceErrors}
        selectedUnifiedId={selectedUnifiedId}
        highlightedUnifiedId={highlightedUnifiedId}
        schedulerStatus={schedulerStatus}
        schedulerHost={schedulerHost}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        selectedKinds={selectedKinds}
        onToggleKind={toggleKindFilter}
        loopOnly={loopOnly}
        onLoopOnlyChange={setLoopOnly}
        onClearKindFilters={clearKindFilters}
        onResetFilters={resetFilters}
        onSelectItem={handleSelectUnifiedItem}
        onRunNow={unifiedActions.runNow}
        onPause={unifiedActions.pause}
        onResume={unifiedActions.resume}
        onDelete={unifiedActions.delete}
        selectedUnifiedIds={multiSelection}
        onToggleUnifiedSelection={handleToggleUnifiedSelection}
        onCreate={handleCreateClick}
      />
    )
  }

  return (
    <>
      <SchedulerShell
        sidebar={renderSidebar}
        isMobileDetailOpen={mobileView === "detail" && Boolean(selectedTask || selectedUnifiedItem)}
        mobileDetail={
          <SchedulerMobileDetailView
            task={selectedTask ?? undefined}
            executions={executions}
            unifiedItem={selectedTask ? undefined : (selectedUnifiedItem ?? undefined)}
            isLoading={isLoading}
            onBack={() => {
              setMobileView("list")
              selectTask(null)
              setSelectedUnifiedItem(null)
            }}
            onPause={handlePause}
            onResume={handleResume}
            onRunNow={handleRunNow}
            onDelete={requestDeleteTask}
            onEdit={() => setShowEditSheet(true)}
            onUnifiedRunNow={unifiedActions.runNow}
            onUnifiedPause={unifiedActions.pause}
            onUnifiedResume={unifiedActions.resume}
            onUnifiedDelete={unifiedActions.delete}
            onSelectRun={setSelectedRun}
            hasMoreExecutions={hasMoreExecutions}
            onLoadMoreExecutions={loadMoreExecutions}
            onCancelPluginExecution={cancelPluginExecution}
            isPluginExecutionActive={isPluginExecutionActive}
          />
        }
        header={
          <div>
            <SchedulerContentHeader
              // Whatever the pane is showing — the breadcrumb used to read
              // "Overview" while a workflow trigger's detail filled the pane.
              selectedTaskName={selectedTask?.name ?? selectedUnifiedItem?.name}
              isRefreshing={isLoading}
              onCreate={handleCreateClick}
              onCreateSystemTask={() => setShowSystemCreateSheet(true)}
              onCreateWorkflowTrigger={() => setShowQuickWorkflowDialog(true)}
              onOpenBackupSettings={() => setShowBackupDialog(true)}
              onOpenPluginSettings={() => router.push("/settings?section=plugins")}
              onRefresh={handleRefresh}
              onExport={() => setShowExportDialog(true)}
              onImport={() => setShowImportDialog(true)}
              onOpenTemplates={() => setShowTemplateGallery(true)}
              onCleanup={handleCleanup}
            />
            <SchedulerHostBar />
          </div>
        }
        detail={
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={
                selectedTask
                  ? `task:${selectedTask.id}`
                  : selectedUnifiedItem
                    ? `unified:${selectedUnifiedItem.unifiedId}`
                    : "dashboard"
              }
              className="h-full"
              {...(prefersReducedMotion
                ? {}
                : {
                    initial: { opacity: 0 },
                    animate: { opacity: 1 },
                    exit: { opacity: 0 },
                    transition: { duration: 0.15 },
                  })}
            >
              {selectedTask ? (
                <SchedulerErrorBoundary panelName="detail">
                  <TaskDetailView
                    task={selectedTask}
                    executions={executions}
                    isLoading={isLoading}
                    onPause={handlePause}
                    onResume={handleResume}
                    onRunNow={handleRunNow}
                    onDelete={requestDeleteTask}
                    onEdit={() => setShowEditSheet(true)}
                    onCancelPluginExecution={cancelPluginExecution}
                    isPluginExecutionActive={isPluginExecutionActive}
                    hasMoreExecutions={hasMoreExecutions}
                    onLoadMoreExecutions={loadMoreExecutions}
                    onSelectExecution={(exec) => setSelectedRun(toUnifiedFromTaskExecution(exec))}
                    allTasks={tasks}
                    onSelectTask={handleSelectTask}
                    onOpenDependencyGraph={() => setShowDependencyDialog(true)}
                    onBackfill={() => setShowBackfillDialog(true)}
                    onClone={handleCloneTask}
                    onPromote={handlePromote}
                    onUnpromote={handleUnpromote}
                    promotionAvailable={promotionAvailable}
                    promotionUnavailableReason={promotionUnavailableReason}
                  />
                </SchedulerErrorBoundary>
              ) : selectedUnifiedItem ? (
                <SchedulerErrorBoundary panelName="detail">
                  <UnifiedTaskDetailView
                    item={selectedUnifiedItem}
                    onRunNow={unifiedActions.runNow}
                    onPause={unifiedActions.pause}
                    onResume={unifiedActions.resume}
                    onDelete={unifiedActions.delete}
                    onSelectRun={setSelectedRun}
                  />
                </SchedulerErrorBoundary>
              ) : (
                <SchedulerErrorBoundary panelName="dashboard">
                  <SchedulerDashboardView
                    statistics={unifiedStatistics}
                    items={unifiedItems}
                    recentRuns={unifiedRecentRuns}
                    onSelectItem={handleSelectUnifiedId}
                    onSelectRun={setSelectedRun}
                    onSelectKind={handleSelectKindFromOverview}
                    selectedKinds={selectedKinds}
                  />
                </SchedulerErrorBoundary>
              )}
            </motion.div>
          </AnimatePresence>
        }
        /*
          The rail is the *global* context strip: what runs next and what ran
          last, regardless of what the detail pane shows. On the overview that
          would be a third copy of blocks already on screen, so it only appears
          once a specific item has taken the pane over.
        */
        rail={
          isDetailOpen ? (
            <SchedulerUpcomingRail
              items={unifiedItems}
              recentRuns={unifiedRecentRuns}
              onSelectItem={handleSelectUnifiedId}
              onSelectRun={setSelectedRun}
            />
          ) : undefined
        }
      />

      <SystemTaskInspectSheet
        open={!!inspectTaskId}
        onOpenChange={(open) => {
          if (!open) setInspectTaskId(null)
        }}
        task={inspectTask}
      />

      <SchedulerDialogs
        showCreateSheet={showCreateSheet}
        createInitialValues={createDraft?.input}
        createDraftSummary={createDraft?.summary}
        onShowCreateSheetChange={(open) => {
          setShowCreateSheet(open)
          // Closing the sheet retires the hand-off; reopening it from the
          // header must give a blank form, not the draft again.
          if (!open) setCreateDraft(null)
        }}
        onCreateTask={handleCreateTask}
        isSubmitting={isSubmitting}
        showEditSheet={showEditSheet}
        onShowEditSheetChange={setShowEditSheet}
        onEditTask={handleEditTask}
        selectedTask={selectedTask}
        showSystemCreateSheet={showSystemCreateSheet}
        onShowSystemCreateSheetChange={setShowSystemCreateSheet}
        onCreateSystemTask={handleCreateSystemTask}
        systemSubmitting={systemSubmitting}
        systemCapabilities={capabilities}
        showSystemEditSheet={showSystemEditSheet}
        onShowSystemEditSheetChange={setShowSystemEditSheet}
        onEditSystemTask={handleEditSystemTask}
        selectedSystemTask={selectedSystemTask}
        systemDeleteTaskId={systemDeleteTaskId}
        onSystemDeleteTaskIdChange={setSystemDeleteTaskId}
        onSystemDeleteConfirm={handleSystemDeleteConfirm}
        pendingConfirmation={pendingConfirmation}
        onConfirmPending={() => {
          void handleConfirmPending()
        }}
        onCancelPending={() => {
          setPendingPromotion(null)
          cancelPending()
        }}
        showAdminDialog={showAdminDialog}
        onShowAdminDialogChange={setShowAdminDialog}
        onRequestElevation={handleRequestElevation}
        existingTasks={tasks}
      />

      <TaskTemplateGallery
        open={showTemplateGallery}
        onOpenChange={setShowTemplateGallery}
        onSelect={handleTemplateSelect}
      />

      <ExportTasksDialog open={showExportDialog} onOpenChange={setShowExportDialog} />

      <ImportTasksDialog open={showImportDialog} onOpenChange={setShowImportDialog} />

      <QuickWorkflowTriggerDialog
        open={showQuickWorkflowDialog}
        onOpenChange={setShowQuickWorkflowDialog}
      />

      {showBackupDialog && (
        <BackupScheduleDialog
          onScheduled={() => {
            setShowBackupDialog(false)
            refresh()
          }}
        />
      )}

      <RunDetailSheet
        open={selectedRun !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedRun(null)
        }}
        run={selectedRun}
      />

      <TaskDependencyDialog
        open={showDependencyDialog}
        onOpenChange={setShowDependencyDialog}
        tasks={tasks}
        focusTaskId={selectedTask?.id}
        onSelectTask={handleSelectTask}
      />

      <BackfillDialog
        open={showBackfillDialog}
        onOpenChange={setShowBackfillDialog}
        task={selectedTask ?? null}
        onBackfill={(range) => {
          if (!selectedTask) return Promise.resolve(0)
          return backfillTask(selectedTask.id, range)
        }}
      />

      <DeleteItemDialog
        item={pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        onConfirm={() => {
          void handleDeleteConfirm()
        }}
      />

      <SchedulerBulkToolbar
        selectedItems={unifiedItems.filter((item) => multiSelection.includes(item.unifiedId))}
        onClearSelection={clearMultiSelection}
      />
    </>
  )
}
