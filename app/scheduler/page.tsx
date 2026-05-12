"use client"

/**
 * Scheduler Page
 * Main page for managing scheduled tasks — SidebarProvider Master-Detail layout.
 */

import { useState, useCallback, useMemo, useEffect, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { useScheduler, useSystemScheduler } from "@/hooks/scheduler"
import { useUnifiedScheduledItems } from "@/hooks/scheduler/use-unified-items"
import { bootstrapSchedulerSources } from "@/lib/scheduler/sources/bootstrap"
import { getSchedulerSourceRegistry } from "@/lib/scheduler/sources/registry"
import { cn } from "@/lib/utils"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import {
  SchedulerSidebar,
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
import { RunDetailSheet } from "@/components/scheduler/run-detail-sheet"
import { SchedulerBulkToolbar } from "@/components/scheduler/scheduler-bulk-toolbar"
import { QuickWorkflowTriggerDialog } from "@/components/scheduler/dialogs/quick-workflow-trigger-dialog"
import { BackupScheduleDialog } from "@/components/scheduler/backup-schedule-dialog"
import { toUnifiedFromTaskExecution } from "@/hooks/scheduler/use-unified-recent-runs"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import type { CreateScheduledTaskInput, CreateSystemTaskInput } from "@/types/scheduler"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"

export default function SchedulerPage() {
  const {
    tasks,
    executions,
    statistics,
    selectedTask,
    activeTasks,
    pausedTasks,
    upcomingTasks,
    recentExecutions,
    schedulerStatus,
    filter,
    isLoading,
    isInitialized,
    createTask,
    updateTask,
    deleteTask,
    pauseTask,
    resumeTask,
    runTaskNow,
    selectTask,
    setFilter,
    clearFilter,
    refresh,
    loadRecentExecutions,
    loadUpcomingTasks,
    cleanupOldExecutions,
    cancelPluginExecution,
    getActivePluginCount: _getActivePluginCount,
    isPluginExecutionActive,
    bulkPause: _bulkPause,
    bulkResume: _bulkResume,
    bulkDelete: _bulkDelete,
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
    cancelPending,
    validateTask,
    requestElevation,
    clearError: clearSystemError,
  } = useSystemScheduler()

  const t = useTranslations("scheduler")

  // Bootstrap the source registry exactly once per process. The bootstrap
  // function is idempotent and registers every source against the singleton
  // registry that `useUnifiedScheduledItems` consumes.
  useEffect(() => {
    bootstrapSchedulerSources()
  }, [])
  const {
    items: unifiedItems,
    countsByKind,
    activeCountsByKind,
  } = useUnifiedScheduledItems({ registry: getSchedulerSourceRegistry() })

  // --- New layout state ---
  const [mobileView, setMobileView] = useState<"list" | "detail">("list")
  const [searchQuery, setSearchQuery] = useState(filter.search || "")
  const [activeFilter, setActiveFilter] = useState("all")
  // Mobile detection — useSyncExternalStore is the React-prescribed way to
  // read external state (matchMedia) without setState-in-effect.
  const isMobile = useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined") return () => {}
      const mq = window.matchMedia("(max-width: 639px)")
      mq.addEventListener("change", notify)
      return () => mq.removeEventListener("change", notify)
    },
    () => window.matchMedia("(max-width: 639px)").matches,
    () => false
  )
  const [highlightedIndex, setHighlightedIndex] = useState(-1)

  // --- Dialog / sheet state ---
  const [showCreateSheet, setShowCreateSheet] = useState(false)
  const [showEditSheet, setShowEditSheet] = useState(false)
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null)
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

  // Derived
  const inspectTask = useMemo(
    () => systemTasks.find((task) => task.id === inspectTaskId) ?? null,
    [systemTasks, inspectTaskId]
  )
  const selectedSystemTask = useMemo(
    () => systemTasks.find((task) => task.id === systemEditTaskId) || null,
    [systemTasks, systemEditTaskId]
  )

  // Filter tasks by search + activeFilter
  const filteredTasks = useMemo(() => {
    let result = tasks
    if (activeFilter === "active") result = result.filter((t) => t.status === "active")
    else if (activeFilter === "paused") result = result.filter((t) => t.status === "paused")
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (t) => t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q)
      )
    }
    return result
  }, [tasks, activeFilter, searchQuery])

  // Load recent executions and upcoming tasks on init
  useEffect(() => {
    if (isInitialized) {
      loadRecentExecutions(20)
      loadUpcomingTasks(5)
    }
  }, [isInitialized, loadRecentExecutions, loadUpcomingTasks])

  // Debounced search filter (syncs to store filter for hook-side filtering)
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
  const [prevFilterKey, setPrevFilterKey] = useState(`${activeFilter}|${searchQuery}`)
  const filterKey = `${activeFilter}|${searchQuery}`
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
    const deleted = await cleanupOldExecutions(30)
    if (deleted > 0) {
      loadRecentExecutions(20)
    }
  }, [cleanupOldExecutions, loadRecentExecutions])

  const handleCreateTask = useCallback(
    async (input: CreateScheduledTaskInput) => {
      setIsSubmitting(true)
      try {
        await createTask(input)
        setShowCreateSheet(false)
      } finally {
        setIsSubmitting(false)
      }
    },
    [createTask]
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

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTaskId) {
      await deleteTask(deleteTaskId)
      setDeleteTaskId(null)
    }
  }, [deleteTaskId, deleteTask])

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

  const handleTemplateSelect = useCallback(
    async (input: CreateScheduledTaskInput) => {
      setIsSubmitting(true)
      try {
        await createTask(input)
      } finally {
        setIsSubmitting(false)
      }
    },
    [createTask]
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

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        setHighlightedIndex((prev) => Math.min(prev + 1, filteredTasks.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setHighlightedIndex((prev) => Math.max(prev - 1, 0))
      } else if (
        e.key === "Enter" &&
        highlightedIndex >= 0 &&
        highlightedIndex < filteredTasks.length
      ) {
        e.preventDefault()
        handleSelectTask(filteredTasks[highlightedIndex].id)
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedTask) {
        e.preventDefault()
        setDeleteTaskId(selectedTask.id)
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
    handleSelectTask,
    selectedTask,
    selectTask,
    isMobile,
    filteredTasks,
    highlightedIndex,
  ])

  // Loading state — show layout-matching skeleton instead of a bare spinner so
  // the user perceives the page shape immediately.
  if (!isInitialized) {
    return <SchedulerSkeleton />
  }

  // Dispatch unified actions to the right adapter based on item.kind. The
  // registry holds one source per kind; each source already knows how to
  // pause/resume/run/delete its native rows.
  const dispatchUnified = (
    action: "runNow" | "pause" | "resume" | "delete"
  ): ((item: UnifiedScheduledItem) => void) => {
    return (item: UnifiedScheduledItem) => {
      const source = getSchedulerSourceRegistry().getSource(item.kind)
      if (!source) return
      void source[action](item.sourceId)
    }
  }

  return (
    <SidebarProvider
      data-bg-target="chat"
      className="flex h-full min-h-0 w-full flex-1 overflow-hidden"
    >
      {/* Mobile detail view — full-screen push. Supports both the app-kind
          rich path (selectedTask) and any unified-kind path
          (selectedUnifiedItem) so users on mobile aren't dead-ended on
          workflow / backup / plugin / connector selections. */}
      {isMobile && mobileView === "detail" && (selectedTask || selectedUnifiedItem) && (
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
          onDelete={setDeleteTaskId}
          onEdit={() => setShowEditSheet(true)}
          onUnifiedRunNow={dispatchUnified("runNow")}
          onUnifiedPause={dispatchUnified("pause")}
          onUnifiedResume={dispatchUnified("resume")}
          onUnifiedDelete={dispatchUnified("delete")}
          onSelectRun={setSelectedRun}
        />
      )}

      {/* Desktop + mobile list layout */}
      <div className={cn("flex h-full", isMobile && mobileView === "detail" && "hidden")}>
        <SchedulerSidebar
          tasks={filteredTasks}
          systemTasks={systemTasks}
          unifiedItems={unifiedItems}
          countsByKind={countsByKind}
          selectedTaskId={selectedTask?.id ?? null}
          schedulerStatus={schedulerStatus}
          statistics={statistics}
          activeCount={activeTasks.length}
          pausedCount={pausedTasks.length}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          onSelectTask={handleSelectTask}
          onSelectSystemTask={setInspectTaskId}
          onSelectUnifiedItem={(item) => {
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
          }}
          onRunNow={handleRunNow}
          onPause={handlePause}
          onResume={handleResume}
          onDelete={setDeleteTaskId}
          onUnifiedRunNow={dispatchUnified("runNow")}
          onUnifiedPause={dispatchUnified("pause")}
          onUnifiedResume={dispatchUnified("resume")}
          onUnifiedDelete={dispatchUnified("delete")}
          selectedUnifiedIds={multiSelection}
          onToggleUnifiedSelection={(item) => toggleMultiSelection(item.unifiedId)}
          onCreate={handleCreateClick}
          highlightedIndex={highlightedIndex}
        />

        <SidebarInset data-bg-target="chat">
          <SchedulerContentHeader
            selectedTaskName={selectedTask?.name}
            isRefreshing={isLoading}
            onCreate={handleCreateClick}
            onCreateSystemTask={() => setShowSystemCreateSheet(true)}
            onCreateWorkflowTrigger={() => setShowQuickWorkflowDialog(true)}
            onOpenBackupSettings={() => setShowBackupDialog(true)}
            onOpenPluginSettings={() => {
              if (typeof window !== "undefined") {
                window.location.assign("/settings?section=plugins")
              }
            }}
            onRefresh={handleRefresh}
            onExport={() => setShowExportDialog(true)}
            onImport={() => setShowImportDialog(true)}
            onOpenTemplates={() => setShowTemplateGallery(true)}
            onCleanup={handleCleanup}
          />

          <div className="flex-1 min-h-0 overflow-auto">
            {selectedTask ? (
              <SchedulerErrorBoundary panelName="detail">
                <TaskDetailView
                  task={selectedTask}
                  executions={executions}
                  isLoading={isLoading}
                  onPause={handlePause}
                  onResume={handleResume}
                  onRunNow={handleRunNow}
                  onDelete={setDeleteTaskId}
                  onEdit={() => setShowEditSheet(true)}
                  onCancelPluginExecution={cancelPluginExecution}
                  isPluginExecutionActive={isPluginExecutionActive}
                  onSelectExecution={(exec) => setSelectedRun(toUnifiedFromTaskExecution(exec))}
                />
              </SchedulerErrorBoundary>
            ) : selectedUnifiedItem ? (
              <SchedulerErrorBoundary panelName="detail">
                <UnifiedTaskDetailView
                  item={selectedUnifiedItem}
                  onRunNow={dispatchUnified("runNow")}
                  onPause={dispatchUnified("pause")}
                  onResume={dispatchUnified("resume")}
                  onDelete={dispatchUnified("delete")}
                  onSelectRun={setSelectedRun}
                />
              </SchedulerErrorBoundary>
            ) : (
              <SchedulerErrorBoundary panelName="dashboard">
                <SchedulerDashboardView
                  statistics={statistics}
                  activeTasks={activeTasks}
                  pausedTasks={pausedTasks}
                  upcomingTasks={upcomingTasks}
                  recentExecutions={recentExecutions}
                  schedulerStatus={schedulerStatus}
                  onSelectTask={handleSelectTask}
                  countsByKind={countsByKind}
                  activeCountsByKind={activeCountsByKind}
                  onSelectRun={setSelectedRun}
                />
              </SchedulerErrorBoundary>
            )}
          </div>
        </SidebarInset>
      </div>

      <SystemTaskInspectSheet
        open={!!inspectTaskId}
        onOpenChange={(open) => {
          if (!open) setInspectTaskId(null)
        }}
        task={inspectTask}
      />

      <SchedulerDialogs
        showCreateSheet={showCreateSheet}
        onShowCreateSheetChange={setShowCreateSheet}
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
        deleteTaskId={deleteTaskId}
        onDeleteTaskIdChange={setDeleteTaskId}
        onDeleteConfirm={handleDeleteConfirm}
        systemDeleteTaskId={systemDeleteTaskId}
        onSystemDeleteTaskIdChange={setSystemDeleteTaskId}
        onSystemDeleteConfirm={handleSystemDeleteConfirm}
        pendingConfirmation={pendingConfirmation}
        onConfirmPending={() => {
          void confirmPending()
        }}
        onCancelPending={cancelPending}
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

      <SchedulerBulkToolbar
        selectedItems={unifiedItems.filter((item) => multiSelection.includes(item.unifiedId))}
        onClearSelection={clearMultiSelection}
      />
    </SidebarProvider>
  )
}
