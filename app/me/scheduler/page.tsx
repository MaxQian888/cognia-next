"use client"

/**
 * `/me/scheduler`: the scheduler in the phone shell (ADR-0179 §6).
 *
 * The same components as `/scheduler` over the same store and the same
 * address, narrower. What needs you comes first, above two tabs: the tasks
 * (search, the desktop's own filter bar, the flat rows) and the activity
 * (the stat strip, fourteen days of outcomes, the agenda and recent runs,
 * which is the desktop overview minus the kind summary the filter menu
 * already counts). A tap pushes `ItemDetail` full-screen, with the run sheet
 * and the same delete confirmation. The desktop shell is not mounted,
 * because a `SidebarProvider` and a resizable group cost a phone something
 * for a layout it never renders.
 *
 * Creation here is app-only; system, workflow and backup creation, bulk
 * actions, templates and import/export stay on the desktop, each needing a
 * surface the phone shell does not have. The rows therefore carry no
 * multi-select checkbox: one that checks nothing is a broken control. A
 * task's own extras (duplicate, backfill, the dependency graph) are dialogs
 * and work here; promotion to the OS scheduler is a desktop capability and
 * is not offered.
 *
 * A layout that is not compact is bounced to `/scheduler`; the two routes
 * are a mutually exclusive pair, never a loop.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConsoleSection } from "@/components/surface/console-section"
import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { FloatingActionButton } from "@/components/ui/floating-action-button"
import { BackfillDialog, TaskForm, SchedulerSkeleton } from "@/components/scheduler"
import { DeleteItemDialog } from "@/components/scheduler/delete-item-dialog"
import { ItemDetail } from "@/components/scheduler/detail/item-detail"
import type { ItemActions } from "@/components/scheduler/detail/item-hero"
import { OutcomeStrip } from "@/components/scheduler/outcome-strip"
import { Agenda } from "@/components/scheduler/overview/agenda"
import { AttentionBlock } from "@/components/scheduler/overview/attention-block"
import { RunDetailSheet } from "@/components/scheduler/run-detail-sheet"
import { RunRow } from "@/components/scheduler/run-row"
import { SchedulerFilterBar } from "@/components/scheduler/scheduler-filter-bar"
import { TaskDependencyDialog } from "@/components/scheduler/task-dependency-dialog"
import {
  SchedulerHostPopover,
  SchedulerHostStatusBadge,
  SchedulerHostSummaryLine,
  useSchedulerHostSummary,
} from "@/components/scheduler/scheduler-host-popover"
import { SchedulerListRow } from "@/components/scheduler/scheduler-list-row"
import { TaskListEmptyState } from "@/components/scheduler/empty-states"
import { useScheduler, useSystemScheduler } from "@/hooks/scheduler"
import { useLocalisedItems } from "@/hooks/scheduler/use-localised-items"
import { useSchedulerListFilter } from "@/hooks/scheduler/use-scheduler-list-filter"
import { useSchedulerSelection } from "@/hooks/scheduler/use-scheduler-selection"
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
import { buildOutcomeCells, summarizeOutcomeCells } from "@/lib/scheduler/outcome-strip"
import { bootstrapSchedulerSources } from "@/lib/scheduler/sources/bootstrap"
import { getSchedulerSourceRegistry } from "@/lib/scheduler/sources/registry"
import { defaultTaskTimezone, seedTaskDefaults } from "@/lib/scheduler/task-defaults"
import { consumeScheduledTaskDraft } from "@/lib/scheduler/task-draft-handoff"
import { workspaceScopeForSchedulerHost } from "@/lib/scheduler/task-workspace-binding"
import { deriveUnifiedStatistics, filterUnifiedItems } from "@/lib/scheduler/unified-filter"
import { COMPACT_ABOVE_TAB_BAR_BOTTOM } from "@/lib/shell/compact-shell"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import type { CreateScheduledTaskInput } from "@/types/scheduler"
import {
  makeUnifiedId,
  parseUnifiedId,
  unifiedKindForTaskType,
  type UnifiedScheduledItem,
} from "@/types/scheduler/unified"
import {
  isAppTableKind,
  taskAnnouncesOutcome,
  useSchedulerItemActions,
} from "@/hooks/scheduler/use-scheduler-item-actions"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

/** Recent runs the activity tab lists; the same cap as the desktop overview. */
const MOBILE_RECENT_RUNS = 10

type MobileSchedulerView = "tasks" | "activity"

export default function MobileSchedulerPage() {
  return (
    <Suspense fallback={<SchedulerSkeleton variant="sidebar" />}>
      <MobileSchedulerBody />
    </Suspense>
  )
}

function MobileSchedulerBody() {
  const t = useTranslations("scheduler")
  const tMobile = useTranslations("mobile.me")
  const router = useRouter()

  // Width, not runtime: a narrow browser tab is a phone-shaped scheduler.
  const compact = useCompactLayout()
  const searchParams = useSearchParams()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])
  useEffect(() => {
    if (!mounted || compact) return
    // The same address on the wider page: the open task stays open.
    const query = searchParams.toString()
    router.replace(query ? `/scheduler?${query}` : "/scheduler")
  }, [compact, mounted, router, searchParams])

  const {
    tasks,
    executions,
    selectedTask,
    isInitialized,
    isLoading,
    createTask,
    updateTask,
    deleteTask,
    pauseTask,
    resumeTask,
    runTaskNow,
    selectTask,
    refresh,
    cancelExecution,
    cloneTask,
    backfillTask,
    hasMoreExecutions,
    loadMoreExecutions,
  } = useScheduler()
  const { tasks: systemTasks, pendingConfirmations, refresh: refreshSystem } = useSystemScheduler()
  const maxTasksPerSource = useSchedulerStore((s) => s.permissionPolicy.maxTasksPerSource)
  const taskDefaults = useSchedulerStore((s) => s.permissionPolicy.taskDefaults)

  useEffect(() => {
    bootstrapSchedulerSources()
  }, [])
  const { items: rawItems, errors: sourceErrors } = useUnifiedScheduledItems({
    registry: getSchedulerSourceRegistry(),
  })
  const items = useLocalisedItems(rawItems)
  const { runs: recentRuns } = useUnifiedRecentRuns({ limit: 200 })
  const tick = useNowTicker()
  const now = Math.floor(tick / 60_000) * 60_000

  const host = useSchedulerHostSummary()
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

  // --- Selection (the address) ---
  const selection = useSchedulerSelection(items, isInitialized)
  const selectedItem = useMemo(
    () => items.find((item) => item.unifiedId === selection.itemId) ?? null,
    [items, selection.itemId]
  )
  const selectedIsAppTable = isAppTableKind(selectedItem?.kind)
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

  // --- Sheets and dialogs ---
  const [showCreateSheet, setShowCreateSheet] = useState(false)
  const [createDraft, setCreateDraft] = useState<{
    input: Partial<CreateScheduledTaskInput>
    summary?: string
  } | null>(null)
  // The composer's "schedule this" hand-off used to expire here unread: the
  // desktop route redirected to this page, and this page never looked.
  useEffect(() => {
    const handed = consumeScheduledTaskDraft()
    if (!handed) return
    queueMicrotask(() => {
      setCreateDraft(handed)
      setShowCreateSheet(true)
    })
  }, [])
  const [showEditSheet, setShowEditSheet] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<UnifiedScheduledItem | null>(null)
  const [showBackfillDialog, setShowBackfillDialog] = useState(false)
  const [showDependencyDialog, setShowDependencyDialog] = useState(false)
  const [view, setView] = useState<MobileSchedulerView>("tasks")
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      // Both schedules, as on the desktop: the OS one feeds the attention
      // block's pending confirmations.
      await Promise.all([refresh(), refreshSystem()])
    } finally {
      setRefreshing(false)
    }
  }, [refresh, refreshSystem])

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

  const handleCreate = useCallback(
    async (input: CreateScheduledTaskInput) => {
      setIsSubmitting(true)
      try {
        const created = await createTask(input)
        if (!created) {
          toast.error(useSchedulerStore.getState().error ?? t("createTaskFailed"))
          return
        }
        setShowCreateSheet(false)
        setCreateDraft(null)
        selection.selectItem(makeUnifiedId(unifiedKindForTaskType(created.type), created.id))
        toast.success(t("itemActions.created", { name: created.name }))
      } finally {
        setIsSubmitting(false)
      }
    },
    [createTask, selection, t]
  )

  const handleEdit = useCallback(
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
          endAt: input.endAt ?? null,
          onSuccessTaskIds: input.onSuccessTaskIds ?? [],
          onFailureTaskIds: input.onFailureTaskIds ?? [],
        })
        if (!updated) {
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
  const removeItem = itemActionsState.remove
  const handleDeleteConfirm = useCallback(async () => {
    const item = pendingDelete
    if (!item) return
    setPendingDelete(null)
    const removed = await removeItem(item)
    if (removed && selection.itemId === item.unifiedId) selection.clear()
  }, [pendingDelete, removeItem, selection])

  const handleCancelRun = useCallback(
    async (run: UnifiedExecutionRun) => {
      const parsed = parseUnifiedId(run.unifiedId)
      if (!parsed || !isAppTableKind(run.kind)) {
        toast.error(t("cancelRunUnreachable"))
        return
      }
      const outcome = await cancelExecution(parsed.sourceId)
      if (outcome.cancelled) toast.success(t("cancelRunSuccess"))
      else if (outcome.reason === "requested") toast.info(t("cancelRunRequested"))
      else if (outcome.reason === "already-settled") toast.info(t("cancelRunAlreadyFinished"))
      else if (outcome.reason === "unsupported-on-remote")
        toast.error(t("cancelRunRemoteUnsupported"))
      else toast.error(t("cancelRunUnreachable"))
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
    selection.selectItem(makeUnifiedId(unifiedKindForTaskType(clone.type), clone.id))
    toast.success(t("cloneSuccess", { name: clone.name }))
  }, [selectedAppTask, cloneTask, selection, t])

  const { runNow: runItemNow, pause: pauseItem, resume: resumeItem } = itemActionsState
  const selectedKind = selectedItem?.kind
  const backfillable =
    selectedKind === "app" &&
    (selectedAppTask?.trigger.type === "cron" || selectedAppTask?.trigger.type === "interval")
  const itemActions = useMemo<ItemActions>(() => {
    return {
      onRunNow: runItemNow,
      onPause: pauseItem,
      onResume: resumeItem,
      onDelete: (item) => setPendingDelete(item),
      onEdit: selectedKind === "app" ? () => setShowEditSheet(true) : undefined,
      // The same app-only extras as the desktop masthead, all of them dialogs
      // that fit a phone. Promotion is absent: it registers the task with the
      // desktop's OS scheduler, which a phone does not have.
      onDuplicate: selectedKind === "app" ? handleCloneTask : undefined,
      onBackfill: backfillable ? () => setShowBackfillDialog(true) : undefined,
      onOpenDependencyGraph:
        selectedKind === "app" ? () => setShowDependencyDialog(true) : undefined,
    }
  }, [runItemNow, pauseItem, resumeItem, selectedKind, handleCloneTask, backfillable])

  if (!mounted || !compact) return null
  if (!isInitialized) return <SchedulerSkeleton variant="sidebar" />

  const outcome = summarizeOutcomeCells(outcomeCells)
  const stats: StatStripItem[] = [
    {
      id: "active",
      label: t("mobile.statStripLabels.active"),
      value: statistics.activeItems,
      total: statistics.totalItems,
      tone: statistics.activeItems > 0 ? "positive" : "neutral",
    },
    {
      id: "paused",
      label: t("mobile.statStripLabels.paused"),
      value: statistics.pausedItems,
      tone: statistics.pausedItems > 0 ? "attention" : "neutral",
    },
    {
      id: "executions",
      label: t("mobile.statStripLabels.executions"),
      value: outcome.succeeded + outcome.failed,
      tone: "neutral",
    },
    {
      id: "successRate",
      label: t("mobile.statStripLabels.successRate"),
      value: outcome.successRate === null ? "—" : `${outcome.successRate}%`,
      tone:
        outcome.successRate === null
          ? "neutral"
          : outcome.successRate >= 90
            ? "positive"
            : outcome.successRate >= 70
              ? "attention"
              : "critical",
    },
  ]

  const showingDetail = Boolean(selectedItem)

  return (
    <>
      <SubPageShell
        title={t("title")}
        backAria={tMobile("appearanceBackAria")}
        testid="mobile-scheduler-page"
        bodyClassName="space-y-4 px-4 py-4 pb-28"
        headerAccessory={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void handleRefresh()}
            disabled={refreshing || isLoading}
            aria-label={t("mobile.refresh")}
            data-testid="mobile-scheduler-refresh"
          >
            <RefreshCwIcon
              className={cn("size-4", (refreshing || isLoading) && "animate-spin")}
              aria-hidden="true"
            />
          </Button>
        }
      >
        <div
          className="flex items-center gap-2 text-xs text-muted-foreground"
          data-testid="mobile-scheduler-host"
        >
          <SchedulerHostSummaryLine summary={host} className="min-w-0 flex-1" />
          <SchedulerHostStatusBadge summary={host} />
          <SchedulerHostPopover />
        </div>

        {/* What needs you stays above the tabs: a failure must not hide
            behind whichever tab was last open. */}
        <AttentionBlock
          signals={signals}
          next={agenda.next}
          onSelectItem={handleSelectUnifiedId}
          onCancelRun={handleCancelRunId}
          onRetrySources={() => void handleRefresh()}
          onSwitchToPaired={host.pairedAvailable ? () => host.setTarget("paired") : undefined}
          onOpenPolicy={() => router.push("/settings?section=scheduled-tasks")}
        />

        <Tabs
          value={view}
          onValueChange={(next) => setView(next as MobileSchedulerView)}
          className="shrink-0 gap-3"
          data-testid="mobile-scheduler-tabs"
        >
          <TabsList className="w-full" aria-label={t("mobile.viewLabel")}>
            <TabsTrigger value="tasks" className="flex-1" data-testid="mobile-scheduler-tab-tasks">
              {t("mobile.tabTasks")}
              <span className="ms-1 tabular-nums text-[10px] opacity-70">{scopedItems.length}</span>
            </TabsTrigger>
            <TabsTrigger
              value="activity"
              className="flex-1"
              data-testid="mobile-scheduler-tab-activity"
            >
              {t("mobile.tabActivity")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tasks" className="space-y-3">
            <div className="space-y-2" data-testid="mobile-scheduler-filters">
              <InputGroup className="h-10">
                <InputGroupAddon align="inline-start">
                  <SearchIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  enterKeyHint="search"
                  value={filter.filter.search}
                  onChange={(event) => filter.setSearch(event.target.value)}
                  placeholder={t("searchTasks")}
                  aria-label={t("searchTasks")}
                  data-testid="mobile-scheduler-search"
                />
                {filter.filter.search ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      onClick={() => filter.setSearch("")}
                      aria-label={t("clearSearch")}
                    >
                      <XIcon className="size-3" />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
              {/* The desktop's filter bar: one row for status and a menu for
                  kinds and /loop, where two rows of eleven chips used to sit. */}
              <SchedulerFilterBar
                className="px-0 pb-0"
                status={filter.filter.status}
                onStatusChange={filter.setStatus}
                statusCounts={filter.facets.statusCounts}
                selectedKinds={filter.kinds}
                onToggleKind={filter.toggleKind}
                countsByKind={filter.facets.countsByKind}
                loopOnly={filter.filter.loopOnly}
                onLoopOnlyChange={filter.setLoopOnly}
                loopCount={filter.facets.loopCount}
                onClearKindFilters={filter.clearKindFilters}
              />
            </div>

            {scopedItems.length === 0 ? (
              <TaskListEmptyState onCreate={() => setShowCreateSheet(true)} />
            ) : orderedItems.length === 0 ? (
              <TaskListEmptyState variant="filtered" onClearFilters={filter.reset} />
            ) : (
              <div className="-mx-2 flex flex-col" role="list" data-testid="mobile-scheduler-list">
                {orderedItems.map((item) => (
                  <div key={item.unifiedId} role="listitem">
                    <SchedulerListRow
                      item={item}
                      signal={signalByItem.get(item.unifiedId) ?? null}
                      selected={selection.itemId === item.unifiedId}
                      checked={false}
                      checkable={false}
                      onSelect={handleSelectItem}
                      onToggleCheck={() => {}}
                    />
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent
            value="activity"
            className="@container/console-pane flex flex-col gap-3"
            data-testid="mobile-scheduler-activity"
          >
            <StatStrip
              stats={stats}
              // The tab is a flex column; without this the grid is the one
              // child that yields, and it collapses to a single clipped row.
              className="shrink-0"
              testId="mobile-scheduler-stats"
              cellTestIdPrefix="mobile-scheduler-stat"
            />
            <ConsoleSection id="mobile-outcomes" title={t("mobile.outcomesTitle")}>
              <OutcomeStrip cells={outcomeCells} testId="mobile-scheduler-outcomes" />
            </ConsoleSection>
            <ConsoleSection
              id="mobile-agenda"
              title={t("overviewPage.agendaTitle", { days: AGENDA_DAYS })}
              meta={agenda.occurrences.length > 0 ? String(agenda.occurrences.length) : undefined}
            >
              <Agenda
                agenda={agenda}
                windowDays={AGENDA_DAYS}
                now={now}
                onSelectItem={handleSelectUnifiedId}
              />
            </ConsoleSection>
            <ConsoleSection
              id="mobile-recent-runs"
              title={t("mobile.recentRunsTitle")}
              meta={
                recentRuns.length > 0
                  ? String(Math.min(recentRuns.length, MOBILE_RECENT_RUNS))
                  : undefined
              }
            >
              {recentRuns.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="mobile-scheduler-no-runs">
                  {t("mobile.noRuns")}
                </p>
              ) : (
                <div className="-mx-2 flex flex-col" data-testid="mobile-scheduler-runs">
                  {recentRuns.slice(0, MOBILE_RECENT_RUNS).map((run) => (
                    <RunRow
                      key={run.unifiedId}
                      run={run}
                      onOpen={handleOpenRun}
                      onCancel={handleCancelRun}
                      showItem
                    />
                  ))}
                </div>
              )}
            </ConsoleSection>
          </TabsContent>
        </Tabs>
      </SubPageShell>

      {showingDetail ? null : (
        <FloatingActionButton
          aria-label={t("mobile.fabCreateAria")}
          data-testid="mobile-scheduler-fab"
          className={COMPACT_ABOVE_TAB_BAR_BOTTOM}
          onClick={() => setShowCreateSheet(true)}
        />
      )}

      {selectedItem ? (
        <div
          className="fixed inset-0 z-40 flex flex-col bg-background safe-area-pt safe-area-pb"
          data-testid="mobile-scheduler-detail-overlay"
        >
          {/* A back bar, not a title bar: the masthead below already names the
              item, and repeating the name here was the first thing on screen
              twice. The label says where back goes. */}
          <header className="flex shrink-0 items-center border-b px-1 py-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => selection.clear()}
              aria-label={t("back")}
              className="h-10 gap-1 px-2 text-sm"
              data-testid="mobile-scheduler-back"
            >
              <ChevronLeftIcon className="size-5" aria-hidden="true" />
              {t("mobile.backToList")}
            </Button>
          </header>
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
            onOpenRun={handleOpenRun}
            onCancelRun={handleCancelRun}
            onSelectItem={handleSelectUnifiedId}
            onBackupScheduled={refresh}
            className="min-h-0 flex-1"
          />
        </div>
      ) : null}

      <Sheet
        open={showCreateSheet}
        onOpenChange={(open) => {
          setShowCreateSheet(open)
          if (!open) setCreateDraft(null)
        }}
      >
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-lg"
          data-testid="mobile-scheduler-create-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("createTask")}</SheetTitle>
            <SheetDescription>
              {createDraft?.summary ?? t("createTaskDescription")}
            </SheetDescription>
          </SheetHeader>
          {/* Inset like the header above: flush, the form ran into the
              screen edge on a phone. */}
          <div className="px-4 pb-6" data-testid="mobile-scheduler-create-body">
            <TaskForm
              key={createDraft ? "draft" : JSON.stringify(taskDefaults ?? "no-defaults")}
              initialValues={createDraft?.input ?? seedTaskDefaults(taskDefaults)}
              defaultTimezone={defaultTaskTimezone(taskDefaults)}
              onSubmit={handleCreate}
              onCancel={() => setShowCreateSheet(false)}
              isSubmitting={isSubmitting}
              existingTasks={tasks}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={showEditSheet} onOpenChange={setShowEditSheet}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-lg"
          data-testid="mobile-scheduler-edit-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("editTask")}</SheetTitle>
            <SheetDescription>{t("editTaskDescription")}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6" data-testid="mobile-scheduler-edit-body">
            {selectedAppTask ? (
              <TaskForm
                initialValues={{
                  name: selectedAppTask.name,
                  description: selectedAppTask.description,
                  type: selectedAppTask.type,
                  trigger: selectedAppTask.trigger,
                  payload: selectedAppTask.payload,
                  config: selectedAppTask.config,
                  notification: selectedAppTask.notification,
                  tags: selectedAppTask.tags,
                  endAt: selectedAppTask.endAt,
                  onSuccessTaskIds: selectedAppTask.onSuccessTaskIds,
                  onFailureTaskIds: selectedAppTask.onFailureTaskIds,
                }}
                onSubmit={handleEdit}
                onCancel={() => setShowEditSheet(false)}
                isSubmitting={isSubmitting}
                existingTasks={tasks}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <BackfillDialog
        open={showBackfillDialog}
        onOpenChange={setShowBackfillDialog}
        task={selectedAppTask ?? null}
        onBackfill={(range) => {
          if (!selectedAppTask) return Promise.resolve(0)
          return backfillTask(selectedAppTask.id, range)
        }}
      />

      <TaskDependencyDialog
        open={showDependencyDialog}
        onOpenChange={setShowDependencyDialog}
        tasks={tasks}
        focusTaskId={selectedAppTask?.id}
        onSelectTask={(taskId) => handleSelectUnifiedId(`app:${taskId}`)}
      />

      <RunDetailSheet
        open={selectedRun !== null}
        onOpenChange={(open) => {
          if (!open) selection.openRun(null)
        }}
        run={selectedRun}
        runs={itemRuns.length > 0 ? itemRuns : recentRuns}
        onNavigate={handleOpenRun}
        onOpenItem={handleSelectUnifiedId}
        onCancelRun={handleCancelRun}
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
