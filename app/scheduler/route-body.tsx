"use client"

/**
 * `/scheduler` (ADR-0179).
 *
 * The route owns the data and the dialogs; the panes render what they are
 * handed. Selection is the address (`?item=`, `?run=`), so every link that
 * means "open this task" lands on it; filters are the scheduler store, so
 * the phone and the desktop show the same rows. `useSearchParams` needs a
 * Suspense boundary under the static export, which is the only reason the
 * default export is a wrapper.
 *
 * A compact viewport is sent to `/me/scheduler`, which renders the same
 * components in a phone shell; the two routes are a mutually exclusive pair.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useScheduler, useSystemScheduler } from "@/hooks/scheduler"
import { useLocalisedItems } from "@/hooks/scheduler/use-localised-items"
import { useSchedulerListFilter } from "@/hooks/scheduler/use-scheduler-list-filter"
import { useSchedulerSelection } from "@/hooks/scheduler/use-scheduler-selection"
import {
  isAppTableKind,
  taskAnnouncesOutcome,
  useSchedulerItemActions,
} from "@/hooks/scheduler/use-scheduler-item-actions"
import { useUnifiedScheduledItems } from "@/hooks/scheduler/use-unified-items"
import {
  toUnifiedFromTaskExecution,
  useUnifiedRecentRuns,
} from "@/hooks/scheduler/use-unified-recent-runs"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { AGENDA_DAYS, buildAgenda } from "@/lib/scheduler/agenda"
import { deriveAttention, signalsForItem, type AttentionSignal } from "@/lib/scheduler/attention"
import { orderListItems } from "@/lib/scheduler/list-order"
import { buildOutcomeCells } from "@/lib/scheduler/outcome-strip"
import { bootstrapSchedulerSources } from "@/lib/scheduler/sources/bootstrap"
import { getSchedulerSourceRegistry } from "@/lib/scheduler/sources/registry"
import { consumeScheduledTaskDraft } from "@/lib/scheduler/task-draft-handoff"
import { workspaceScopeForSchedulerHost } from "@/lib/scheduler/task-workspace-binding"
import { deriveUnifiedStatistics, filterUnifiedItems } from "@/lib/scheduler/unified-filter"
import { useProjectStore } from "@/stores/project/project-store"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import type { CreateScheduledTaskInput, CreateSystemTaskInput } from "@/types/scheduler"
import {
  makeUnifiedId,
  parseUnifiedId,
  unifiedKindForTaskType,
  type UnifiedScheduledItem,
} from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import {
  BackfillDialog,
  SchedulerDialogs,
  SchedulerErrorBoundary,
  SchedulerShell,
  SchedulerSkeleton,
  TaskTemplateGallery,
  ExportTasksDialog,
  ImportTasksDialog,
} from "@/components/scheduler"
import { BackupScheduleDialog } from "@/components/scheduler/backup-schedule-dialog"
import { DeleteItemDialog } from "@/components/scheduler/delete-item-dialog"
import { ItemDetail } from "@/components/scheduler/detail/item-detail"
import type { ItemActions } from "@/components/scheduler/detail/item-hero"
import { QuickWorkflowTriggerDialog } from "@/components/scheduler/dialogs/quick-workflow-trigger-dialog"
import { SchedulerOverview } from "@/components/scheduler/overview/scheduler-overview"
import { RunDetailSheet } from "@/components/scheduler/run-detail-sheet"
import { CleanupRunsDialog } from "@/components/scheduler/cleanup-runs-dialog"
import {
  JUST_CREATED_HIGHLIGHT_MS,
  staticIf,
  viewSwitchVariants,
} from "@/components/scheduler/scheduler-motion"
import { SchedulerBulkToolbar } from "@/components/scheduler/scheduler-bulk-toolbar"
import { useSchedulerHostSummary } from "@/components/scheduler/scheduler-host-popover"
import { SchedulerListPane, SchedulerListSidebar } from "@/components/scheduler/scheduler-list-pane"
import { SchedulerPageHeader } from "@/components/scheduler/scheduler-page-header"
import { TaskDependencyDialog } from "@/components/scheduler/task-dependency-dialog"

/**
 * Delete / Backspace asks to delete the selected task only while nothing else
 * has focus, or focus is on the list or the detail itself. A header button or
 * the host popover keeps its own keys.
 */
function focusIsOnSchedule(target: EventTarget | null): boolean {
  if (typeof document !== "undefined" && target === document.body) return true
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest(
      '[data-testid="scheduler-list"], [data-testid="scheduler-list-pane"], [data-testid="item-detail"]'
    )
  )
}

/** An agent-created task this recent is "just added" when it appears. */
const AGENT_CREATE_RECENCY_MS = 2 * 60_000

/** Old runs the header's clean-up removes: anything older than this. */
const CLEANUP_MAX_AGE_DAYS = 30

/**
 * Whether a key press belongs to something else on screen: a field being
 * typed in, or a dialog, sheet or menu that owns the keyboard while open.
 */
function keyboardIsBusy(target: EventTarget | null): boolean {
  if (typeof document !== "undefined") {
    const overlay = document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"]'
    )
    if (overlay) return true
  }
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  const role = target.getAttribute("role")
  return role === "textbox" || role === "combobox" || role === "searchbox"
}

/** A coarse clock for sorting and bucketing: the second ticker would reorder the list every second. */
function useMinuteClock(): number {
  const now = useNowTicker()
  return Math.floor(now / 60_000) * 60_000
}

export default function SchedulerPage() {
  return (
    <Suspense fallback={<SchedulerSkeleton />}>
      <SchedulerPageBody />
    </Suspense>
  )
}

function SchedulerPageBody() {
  const router = useRouter()
  const t = useTranslations("scheduler")
  const prefersReducedMotion = useReducedMotion()

  // One scheduler with two entrances beats two that disagree about filters.
  const compact = useCompactLayout()
  const searchParams = useSearchParams()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])
  useEffect(() => {
    if (!mounted || !compact) return
    // Keep `?item=` / `?run=`: a link that meant "open this task" must still
    // mean it on a phone-sized window.
    const query = searchParams.toString()
    router.replace(query ? `/me/scheduler?${query}` : "/me/scheduler")
  }, [compact, mounted, router, searchParams])

  const {
    tasks,
    executions,
    selectedTask,
    schedulerStatus,
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
    refresh,
    cleanupOldExecutions,
    cloneTask,
    cancelExecution,
    hasMoreExecutions,
    loadMoreExecutions,
  } = useScheduler()

  const {
    capabilities,
    tasks: systemTasks,
    pendingConfirmation,
    pendingConfirmations,
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

  const multiSelection = useSchedulerStore((s) => s.multiSelection)
  const toggleMultiSelection = useSchedulerStore((s) => s.toggleMultiSelection)
  const clearMultiSelection = useSchedulerStore((s) => s.clearMultiSelection)
  const setMultiSelection = useSchedulerStore((s) => s.setMultiSelection)
  const maxTasksPerSource = useSchedulerStore((s) => s.permissionPolicy.maxTasksPerSource)

  const host = useSchedulerHostSummary()
  const promotionAvailable = host.target === "local" && capabilities?.available === true
  const promotionUnavailableReason =
    host.target !== "local"
      ? t("promote.unavailableRemote")
      : capabilities?.available
        ? undefined
        : t("promote.unavailableHost")

  useEffect(() => {
    bootstrapSchedulerSources()
  }, [])
  const { items: rawItems, errors: sourceErrors } = useUnifiedScheduledItems({
    registry: getSchedulerSourceRegistry(),
  })
  const items = useLocalisedItems(rawItems)
  const { runs: recentRuns } = useUnifiedRecentRuns({ limit: 200 })
  const now = useMinuteClock()

  // --- Scope, filter, order ---
  const localProjectId = useProjectStore((s) => s.activeProjectId)
  const workspaceScope = workspaceScopeForSchedulerHost(host.target, localProjectId)
  const scopedItems = useMemo(
    () => filterUnifiedItems(items, { projectId: workspaceScope }),
    [items, workspaceScope]
  )
  const filter = useSchedulerListFilter(items, workspaceScope)
  const statistics = useMemo(() => deriveUnifiedStatistics(scopedItems), [scopedItems])

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const signals = useMemo(
    () =>
      deriveAttention({
        items: scopedItems,
        tasksById,
        runs: recentRuns,
        pendingConfirmations: pendingConfirmations.length,
        hostSuspended: host.suspended,
        sourceErrors,
        maxTasksPerSource,
      }),
    [
      scopedItems,
      tasksById,
      recentRuns,
      pendingConfirmations.length,
      host.suspended,
      sourceErrors,
      maxTasksPerSource,
    ]
  )
  const signalByItem = useMemo(() => {
    const map = new Map<string, AttentionSignal | null>()
    for (const signal of signals) {
      if (signal.itemUnifiedId && !map.has(signal.itemUnifiedId))
        map.set(signal.itemUnifiedId, signal)
    }
    return map
  }, [signals])
  const orderedItems = useMemo(
    () => orderListItems(filter.facets.visibleItems, { signalByItem, now }),
    [filter.facets.visibleItems, signalByItem, now]
  )

  const outcomeCells = useMemo(() => buildOutcomeCells(recentRuns, { now }), [recentRuns, now])
  const agenda = useMemo(
    () => buildAgenda(scopedItems, { now, days: AGENDA_DAYS }),
    [scopedItems, now]
  )
  const runningCount = useMemo(
    () => recentRuns.filter((run) => run.status === "running").length,
    [recentRuns]
  )

  // --- Selection (the address) ---
  const selection = useSchedulerSelection(items, isInitialized)
  const selectedItem = useMemo(
    () => items.find((item) => item.unifiedId === selection.itemId) ?? null,
    [items, selection.itemId]
  )
  const selectedIsAppTable = isAppTableKind(selectedItem?.kind)
  // The app store's selection follows the address for app-table rows, which
  // is what loads their executions (and the load-more cursor) into the store.
  const selectedSourceId = selectedIsAppTable ? selectedItem!.sourceId : null
  useEffect(() => {
    selectTask(selectedSourceId)
  }, [selectedSourceId, selectTask])

  const selectedAppTask = useMemo(
    () => (selectedSourceId ? (tasksById.get(selectedSourceId) ?? selectedTask) : undefined),
    [selectedSourceId, tasksById, selectedTask]
  )
  const selectedSystemTask = useMemo(
    () =>
      selectedItem?.kind === "system"
        ? systemTasks.find((task) => task.id === selectedItem.sourceId)
        : undefined,
    [selectedItem, systemTasks]
  )

  const itemRuns = useMemo<UnifiedExecutionRun[]>(() => {
    if (!selectedItem) return []
    if (selectedIsAppTable) return executions.map(toUnifiedFromTaskExecution)
    return recentRuns.filter((run) => run.itemUnifiedId === selectedItem.unifiedId)
  }, [selectedItem, selectedIsAppTable, executions, recentRuns])
  const itemOutcomeCells = useMemo(() => buildOutcomeCells(itemRuns, { now }), [itemRuns, now])
  const itemSignals = useMemo(
    () => (selectedItem ? signalsForItem(signals, selectedItem.unifiedId) : []),
    [signals, selectedItem]
  )

  const selectedRun = useMemo(() => {
    if (!selection.runId) return null
    return (
      itemRuns.find((run) => run.unifiedId === selection.runId) ??
      recentRuns.find((run) => run.unifiedId === selection.runId) ??
      null
    )
  }, [selection.runId, itemRuns, recentRuns])
  const sheetRuns = itemRuns.length > 0 ? itemRuns : recentRuns

  // --- Dialog state ---
  const [showCreateSheet, setShowCreateSheet] = useState(false)
  const [createDraft, setCreateDraft] = useState<{
    input: Partial<CreateScheduledTaskInput>
    summary?: string
  } | null>(null)
  // Pick up a draft handed over by the composer exactly once; the stash
  // clears itself. Deferred by a microtask so the effect body sets no state.
  useEffect(() => {
    const handed = consumeScheduledTaskDraft()
    if (!handed) return
    queueMicrotask(() => {
      setCreateDraft(handed)
      setShowCreateSheet(true)
    })
  }, [])
  const [showEditSheet, setShowEditSheet] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<UnifiedScheduledItem | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showSystemCreateSheet, setShowSystemCreateSheet] = useState(false)
  const [showSystemEditSheet, setShowSystemEditSheet] = useState(false)
  const [systemDeleteTaskId, setSystemDeleteTaskId] = useState<string | null>(null)
  const [systemSubmitting, setSystemSubmitting] = useState(false)
  const [showAdminDialog, setShowAdminDialog] = useState(false)
  const [showTemplateGallery, setShowTemplateGallery] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showQuickWorkflowDialog, setShowQuickWorkflowDialog] = useState(false)
  const [showBackupDialog, setShowBackupDialog] = useState(false)
  const [showDependencyDialog, setShowDependencyDialog] = useState(false)
  const [showBackfillDialog, setShowBackfillDialog] = useState(false)
  const [pendingPromotion, setPendingPromotion] = useState<{
    taskId: string
    token: string
  } | null>(null)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [showCleanupDialog, setShowCleanupDialog] = useState(false)

  // The row a create just added: ringed and scrolled into view, then let go.
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null)
  useEffect(() => {
    if (!justCreatedId) return
    const timer = window.setTimeout(() => setJustCreatedId(null), JUST_CREATED_HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [justCreatedId])
  // An assistant can add a task from a conversation while this page is open;
  // that row deserves the same "here it is" as one added from the header.
  const seenTaskIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!isInitialized) return
    const seen = seenTaskIds.current
    seenTaskIds.current = new Set(tasks.map((task) => task.id))
    if (!seen) return
    const fresh = tasks.find(
      (task) =>
        !seen.has(task.id) &&
        task.createdBy?.kind === "agent" &&
        Date.now() - new Date(task.createdAt).getTime() < AGENT_CREATE_RECENCY_MS
    )
    if (!fresh) return
    // Deferred so the effect body itself sets no state.
    queueMicrotask(() =>
      setJustCreatedId(makeUnifiedId(unifiedKindForTaskType(fresh.type), fresh.id))
    )
  }, [tasks, isInitialized])

  const itemActionsState = useSchedulerItemActions({
    runTaskNow,
    pauseTask,
    resumeTask,
    deleteTask,
    runs: recentRuns,
    onOpenRun: (runUnifiedId) => selection.openRun(runUnifiedId),
    announcesOutcome: (item, outcome) =>
      isAppTableKind(item.kind) && taskAnnouncesOutcome(tasksById.get(item.sourceId), outcome),
  })

  // The keyboard cursor resets whenever the rows change.
  const listKey = orderedItems.map((item) => item.unifiedId).join("|")
  const [prevListKey, setPrevListKey] = useState(listKey)
  if (listKey !== prevListKey) {
    setPrevListKey(listKey)
    setHighlightedIndex(-1)
  }

  // --- Handlers ---
  const handleSelectItem = useCallback(
    (item: UnifiedScheduledItem) => selection.selectItem(item.unifiedId),
    [selection]
  )
  const handleSelectUnifiedId = useCallback(
    (unifiedId: string) => {
      if (items.some((item) => item.unifiedId === unifiedId)) selection.selectItem(unifiedId)
    },
    [items, selection]
  )
  const handleOpenRun = useCallback(
    (run: UnifiedExecutionRun) => selection.openRun(run.unifiedId),
    [selection]
  )

  const handleCreateTask = useCallback(
    async (input: CreateScheduledTaskInput) => {
      setIsSubmitting(true)
      try {
        const created = await createTask(input)
        if (!created) {
          // A refusal by the permission policy keeps the sheet open and says why.
          toast.error(useSchedulerStore.getState().error ?? t("createTaskFailed"))
          return
        }
        setShowCreateSheet(false)
        const createdId = makeUnifiedId(unifiedKindForTaskType(created.type), created.id)
        selection.selectItem(createdId)
        setJustCreatedId(createdId)
        toast.success(t("itemActions.created", { name: created.name }))
      } finally {
        setIsSubmitting(false)
      }
    },
    [createTask, selection, t]
  )

  const handleEditTask = useCallback(
    async (input: CreateScheduledTaskInput) => {
      if (!selectedAppTask) return
      setIsSubmitting(true)
      try {
        const updated = await updateTask(selectedAppTask.id, {
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
        if (!updated) {
          // The sheet stays open with the user's edits; closing it would read
          // as saved.
          toast.error(t("updateTaskFailed"), {
            description: useSchedulerStore.getState().error ?? undefined,
          })
          return
        }
        setShowEditSheet(false)
        toast.success(t("itemActions.saved", { name: updated.name }))
      } finally {
        setIsSubmitting(false)
      }
    },
    [selectedAppTask, updateTask, t]
  )

  const submitSystemTask = useCallback(
    async (
      input: CreateSystemTaskInput,
      send: (input: CreateSystemTaskInput) => ReturnType<typeof createSystemTask>,
      onSuccess: () => void
    ) => {
      setSystemSubmitting(true)
      clearSystemError()
      try {
        const validation = await validateTask(input)
        if (!validation.valid) {
          clearSystemError()
          return
        }
        const response = await send(input)
        if (response.status === "success") {
          onSuccess()
        } else if (response.status === "error") {
          if (response.message.toLowerCase().includes("administrator")) setShowAdminDialog(true)
          else toast.error(response.message)
        }
      } finally {
        setSystemSubmitting(false)
      }
    },
    [clearSystemError, validateTask]
  )

  const handleCreateSystemTask = useCallback(
    (input: CreateSystemTaskInput) =>
      submitSystemTask(input, createSystemTask, () => setShowSystemCreateSheet(false)),
    [submitSystemTask, createSystemTask]
  )

  const handleEditSystemTask = useCallback(
    (input: CreateSystemTaskInput) => {
      if (!selectedSystemTask) return Promise.resolve()
      return submitSystemTask(
        input,
        (next) => updateSystemTask(selectedSystemTask.id, next),
        () => setShowSystemEditSheet(false)
      )
    },
    [submitSystemTask, selectedSystemTask, updateSystemTask]
  )

  const handleSystemDeleteConfirm = useCallback(async () => {
    if (!systemDeleteTaskId) return
    const name = systemTasks.find((task) => task.id === systemDeleteTaskId)?.name ?? ""
    const ok = await deleteSystemTask(systemDeleteTaskId).catch(() => false)
    setSystemDeleteTaskId(null)
    if (ok) toast.success(t("itemActions.deleted", { name }))
    else toast.error(t("actionFailed", { name }))
  }, [systemDeleteTaskId, deleteSystemTask, systemTasks, t])

  const removeItem = itemActionsState.remove
  const handleDeleteConfirm = useCallback(async () => {
    const item = pendingDelete
    if (!item) return
    setPendingDelete(null)
    const removed = await removeItem(item)
    if (removed && selection.itemId === item.unifiedId) selection.clear()
  }, [pendingDelete, removeItem, selection])

  /**
   * Stop a running run, and say what actually happened. Only app-table runs
   * have a cancel path; the rest are told so rather than shown a control
   * that silently does nothing.
   */
  const handleCancelRun = useCallback(
    async (run: UnifiedExecutionRun) => {
      const parsed = parseUnifiedId(run.unifiedId)
      if (!parsed || !isAppTableKind(run.kind)) {
        toast.error(t("cancelRunUnreachable"))
        return
      }
      const outcome = await cancelExecution(parsed.sourceId)
      if (outcome.cancelled) {
        toast.success(t("cancelRunSuccess"))
        return
      }
      switch (outcome.reason) {
        case "requested":
          toast.info(t("cancelRunRequested"))
          break
        case "already-settled":
          toast.info(t("cancelRunAlreadyFinished"))
          break
        case "unsupported-on-remote":
          toast.error(t("cancelRunRemoteUnsupported"))
          break
        default:
          toast.error(t("cancelRunUnreachable"))
      }
    },
    [cancelExecution, t]
  )
  const handleCancelRunId = useCallback(
    (runUnifiedId: string) => {
      const run = recentRuns.find((candidate) => candidate.unifiedId === runUnifiedId)
      if (run) void handleCancelRun(run)
    },
    [recentRuns, handleCancelRun]
  )

  const handleCloneTask = useCallback(async () => {
    if (!selectedAppTask) return
    const clone = await cloneTask(selectedAppTask.id)
    if (!clone) {
      toast.error(t("cloneFailed"))
      return
    }
    const cloneId = makeUnifiedId(unifiedKindForTaskType(clone.type), clone.id)
    selection.selectItem(cloneId)
    setJustCreatedId(cloneId)
    toast.success(t("cloneSuccess", { name: clone.name }))
  }, [selectedAppTask, cloneTask, selection, t])

  const handlePromote = useCallback(async () => {
    if (!selectedAppTask) return
    const result = await promoteTask(selectedAppTask.id)
    switch (result.status) {
      case "promoted":
        toast.success(t("promote.success"))
        break
      case "confirmation_required":
        setPendingPromotion({ taskId: selectedAppTask.id, token: result.token })
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
  }, [selectedAppTask, promoteTask, refreshSystem, t])

  const handleUnpromote = useCallback(async () => {
    if (!selectedAppTask) return
    const ok = await unpromoteTask(selectedAppTask.id)
    if (ok) toast.success(t("promote.removed"))
    else toast.error(t("promote.removeFailed"))
  }, [selectedAppTask, unpromoteTask, t])

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
        else {
          const createdId = makeUnifiedId(unifiedKindForTaskType(created.type), created.id)
          selection.selectItem(createdId)
          setJustCreatedId(createdId)
          toast.success(t("itemActions.created", { name: created.name }))
        }
      } finally {
        setIsSubmitting(false)
      }
    },
    [createTask, selection, t]
  )

  const handleRequestElevation = useCallback(async () => {
    setSystemSubmitting(true)
    await requestElevation()
    setSystemSubmitting(false)
    setShowAdminDialog(false)
    refreshSystem()
  }, [requestElevation, refreshSystem])

  const handleRefresh = useCallback(() => {
    refresh()
    refreshSystem()
  }, [refresh, refreshSystem])

  /**
   * Run / pause / resume / delete for any kind, through the shared hook: the
   * store for app-table rows, the source otherwise, and an answer either way.
   */
  const { runNow: runItemNow, pause: pauseItem, resume: resumeItem } = itemActionsState
  const itemActions = useMemo<ItemActions>(() => {
    return {
      onRunNow: runItemNow,
      onPause: pauseItem,
      onResume: resumeItem,
      onDelete: (item) => setPendingDelete(item),
      onEdit:
        selectedItem?.kind === "app"
          ? () => setShowEditSheet(true)
          : selectedItem?.kind === "system"
            ? () => setShowSystemEditSheet(true)
            : undefined,
      onDuplicate: selectedItem?.kind === "app" ? handleCloneTask : undefined,
      onBackfill:
        selectedAppTask &&
        selectedItem?.kind === "app" &&
        (selectedAppTask.trigger.type === "cron" || selectedAppTask.trigger.type === "interval")
          ? () => setShowBackfillDialog(true)
          : undefined,
      onOpenDependencyGraph:
        selectedItem?.kind === "app" ? () => setShowDependencyDialog(true) : undefined,
      onPromote: selectedItem?.kind === "app" ? handlePromote : undefined,
      onUnpromote: selectedItem?.kind === "app" ? handleUnpromote : undefined,
      promoted: Boolean(selectedAppTask?.promotion),
      promotionAvailable,
      promotionUnavailableReason,
    }
  }, [
    runItemNow,
    pauseItem,
    resumeItem,
    selectedItem?.kind,
    selectedAppTask,
    handleCloneTask,
    handlePromote,
    handleUnpromote,
    promotionAvailable,
    promotionUnavailableReason,
  ])

  const handleCheckAll = useCallback(
    () => setMultiSelection(orderedItems.map((item) => item.unifiedId)),
    [setMultiSelection, orderedItems]
  )
  const handleToggleCheck = useCallback(
    (item: UnifiedScheduledItem) => toggleMultiSelection(item.unifiedId),
    [toggleMultiSelection]
  )

  // Keyboard: arrows walk the rendered list, Enter opens, Delete asks, n / r.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Escape is left to an open dialog or sheet, which closes itself.
      if (keyboardIsBusy(event.target)) return
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setHighlightedIndex((prev) => Math.min(prev + 1, orderedItems.length - 1))
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        setHighlightedIndex((prev) => Math.max(prev - 1, 0))
      } else if (
        event.key === "Enter" &&
        highlightedIndex >= 0 &&
        highlightedIndex < orderedItems.length
      ) {
        event.preventDefault()
        handleSelectItem(orderedItems[highlightedIndex])
      } else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedItem?.capabilities.delete &&
        focusIsOnSchedule(event.target)
      ) {
        event.preventDefault()
        setPendingDelete(selectedItem)
      } else if (event.key === "n" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setShowCreateSheet(true)
      } else if (event.key === "r" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        handleRefresh()
      } else if (event.key === "Escape") {
        setShowCreateSheet(false)
        setShowEditSheet(false)
        setShowSystemCreateSheet(false)
        setShowSystemEditSheet(false)
        if (selection.runId) selection.openRun(null)
        else if (selection.itemId) selection.clear()
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [orderedItems, highlightedIndex, selectedItem, handleSelectItem, handleRefresh, selection])

  if (compact || !isInitialized) {
    return <SchedulerSkeleton />
  }

  const highlightedId =
    highlightedIndex >= 0 && highlightedIndex < orderedItems.length
      ? orderedItems[highlightedIndex].unifiedId
      : null

  const bulkToolbar = (
    <SchedulerBulkToolbar
      selectedItems={items.filter((item) => multiSelection.includes(item.unifiedId))}
      onClearSelection={clearMultiSelection}
    />
  )

  const renderList = (variant: "chrome" | "content") => {
    const Pane = variant === "chrome" ? SchedulerListSidebar : SchedulerListPane
    return (
      <Pane
        items={orderedItems}
        totalCount={scopedItems.length}
        filter={filter}
        signalByItem={signalByItem}
        sourceErrors={sourceErrors}
        selectedId={selection.itemId}
        highlightedId={highlightedId}
        checkedIds={multiSelection}
        onSelect={handleSelectItem}
        onToggleCheck={handleToggleCheck}
        onCheckAll={handleCheckAll}
        onClearChecks={clearMultiSelection}
        onCreate={() => setShowCreateSheet(true)}
        bulkToolbar={bulkToolbar}
        justCreatedId={justCreatedId}
      />
    )
  }

  return (
    <>
      <SchedulerShell
        sidebar={renderList}
        header={
          <SchedulerPageHeader
            schedulerStatus={schedulerStatus}
            isRefreshing={isLoading}
            onCreate={() => setShowCreateSheet(true)}
            onCreateSystemTask={() => setShowSystemCreateSheet(true)}
            onCreateWorkflowTrigger={() => setShowQuickWorkflowDialog(true)}
            onOpenBackupSettings={() => setShowBackupDialog(true)}
            onOpenPluginSettings={() => router.push("/settings?section=plugins")}
            onRefresh={handleRefresh}
            onExport={() => setShowExportDialog(true)}
            onImport={() => setShowImportDialog(true)}
            onOpenTemplates={() => setShowTemplateGallery(true)}
            onCleanup={() => setShowCleanupDialog(true)}
          />
        }
        detail={
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={selectedItem ? `item:${selectedItem.unifiedId}` : "overview"}
              className="h-full"
              // Overview ↔ item and item ↔ item: a short rise-and-fade, the
              // same step the dashboard views use.
              variants={staticIf(prefersReducedMotion, viewSwitchVariants)}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              {selectedItem ? (
                <SchedulerErrorBoundary panelName="detail">
                  <ItemDetail
                    item={selectedItem}
                    task={selectedIsAppTable ? selectedAppTask : undefined}
                    systemTask={selectedSystemTask}
                    signals={itemSignals}
                    runs={itemRuns}
                    runsLoading={isLoading}
                    hasMoreRuns={selectedIsAppTable ? hasMoreExecutions : false}
                    onLoadMoreRuns={selectedIsAppTable ? loadMoreExecutions : undefined}
                    selectedRunId={selection.runId}
                    outcomeCells={itemOutcomeCells}
                    allTasks={tasks}
                    actions={itemActions}
                    pendingAction={itemActionsState.pending[selectedItem.unifiedId]}
                    onBack={selection.clear}
                    onOpenRun={handleOpenRun}
                    onCancelRun={handleCancelRun}
                    onSelectItem={handleSelectUnifiedId}
                    onBackupScheduled={refresh}
                  />
                </SchedulerErrorBoundary>
              ) : (
                <SchedulerErrorBoundary panelName="dashboard">
                  <SchedulerOverview
                    signals={signals}
                    statistics={statistics}
                    outcomeCells={outcomeCells}
                    agenda={agenda}
                    agendaDays={AGENDA_DAYS}
                    now={now}
                    recentRuns={recentRuns}
                    runningCount={runningCount}
                    selectedKinds={filter.kinds}
                    onToggleKind={filter.toggleKind}
                    onSelectItem={handleSelectUnifiedId}
                    onOpenRun={handleOpenRun}
                    onCancelRun={handleCancelRun}
                    attentionActions={{
                      onCancelRun: handleCancelRunId,
                      onRetrySources: handleRefresh,
                      onSwitchToPaired: host.pairedAvailable
                        ? () => host.setTarget("paired")
                        : undefined,
                      onOpenPolicy: () => router.push("/settings?section=scheduled-tasks"),
                    }}
                  />
                </SchedulerErrorBoundary>
              )}
            </motion.div>
          </AnimatePresence>
        }
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
        selectedTask={selectedItem?.kind === "app" ? selectedAppTask : undefined}
        showSystemCreateSheet={showSystemCreateSheet}
        onShowSystemCreateSheetChange={setShowSystemCreateSheet}
        onCreateSystemTask={handleCreateSystemTask}
        systemSubmitting={systemSubmitting}
        systemCapabilities={capabilities}
        showSystemEditSheet={showSystemEditSheet}
        onShowSystemEditSheetChange={setShowSystemEditSheet}
        onEditSystemTask={handleEditSystemTask}
        selectedSystemTask={selectedSystemTask ?? null}
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
        // The unfiltered list: the dependency pickers used to shrink with the search box.
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
      <BackupScheduleDialog
        open={showBackupDialog}
        onOpenChange={setShowBackupDialog}
        onScheduled={(taskId) => {
          setShowBackupDialog(false)
          refresh()
          const createdId = makeUnifiedId("app", taskId)
          selection.selectItem(createdId)
          setJustCreatedId(createdId)
        }}
      />

      <CleanupRunsDialog
        open={showCleanupDialog}
        onOpenChange={setShowCleanupDialog}
        maxAgeDays={CLEANUP_MAX_AGE_DAYS}
        onConfirm={() => cleanupOldExecutions(CLEANUP_MAX_AGE_DAYS)}
      />

      <RunDetailSheet
        open={selectedRun !== null}
        onOpenChange={(open) => {
          if (!open) selection.openRun(null)
        }}
        run={selectedRun}
        runs={sheetRuns}
        onNavigate={handleOpenRun}
        onOpenItem={handleSelectUnifiedId}
        onCancelRun={handleCancelRun}
      />

      <TaskDependencyDialog
        open={showDependencyDialog}
        onOpenChange={setShowDependencyDialog}
        tasks={tasks}
        focusTaskId={selectedAppTask?.id}
        onSelectTask={(taskId) => handleSelectUnifiedId(`app:${taskId}`)}
      />

      <BackfillDialog
        open={showBackfillDialog}
        onOpenChange={setShowBackfillDialog}
        task={selectedAppTask ?? null}
        onBackfill={(range) => {
          if (!selectedAppTask) return Promise.resolve(0)
          return backfillTask(selectedAppTask.id, range)
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
    </>
  )
}
