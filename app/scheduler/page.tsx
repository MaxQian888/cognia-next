"use client"

/**
 * Scheduler Page
 * Main page for managing scheduled tasks — SidebarProvider Master-Detail layout.
 */

import { useState, useCallback, useMemo, useEffect, useRef, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { RefreshCw } from "lucide-react"
import { useScheduler, useSystemScheduler } from "@/hooks/scheduler"
import { cn } from "@/lib/utils"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import {
  SchedulerSidebar,
  SchedulerDashboardView,
  TaskDetailView,
  // WorkflowScheduleDialog / BackupScheduleDialog were removed — cognia-next
  // has no workflow or backup subsystems. The header menu items that opened
  // them are pruned too (see scheduler-content-header.tsx).
  TaskTemplateGallery,
  ExportTasksDialog,
  ImportTasksDialog,
} from "@/components/scheduler"
import { SystemTaskInspectSheet } from "@/components/scheduler/system-task-inspect-sheet"
import type { CreateScheduledTaskInput, CreateSystemTaskInput } from "@/types/scheduler"
import { SchedulerContentHeader } from "./scheduler-content-header"
import { SchedulerMobileDetailView } from "./scheduler-mobile-detail"
import { SchedulerDialogs } from "./scheduler-dialogs"

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

  // Workflow/backup hidden trigger refs were dropped along with their dialogs.

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

  // Loading state
  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">{t("initializing")}</p>
        </div>
      </div>
    )
  }

  return (
    <SidebarProvider>
      {/* Mobile detail view — full-screen push */}
      {isMobile && mobileView === "detail" && selectedTask && (
        <SchedulerMobileDetailView
          task={selectedTask}
          executions={executions}
          isLoading={isLoading}
          onBack={() => {
            setMobileView("list")
            selectTask(null)
          }}
          onPause={handlePause}
          onResume={handleResume}
          onRunNow={handleRunNow}
          onDelete={setDeleteTaskId}
          onEdit={() => setShowEditSheet(true)}
        />
      )}

      {/* Desktop + mobile list layout */}
      <div className={cn("flex h-full", isMobile && mobileView === "detail" && "hidden")}>
        <SchedulerSidebar
          tasks={filteredTasks}
          systemTasks={systemTasks}
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
          onRunNow={handleRunNow}
          onPause={handlePause}
          onResume={handleResume}
          onDelete={setDeleteTaskId}
          highlightedIndex={highlightedIndex}
        />

        <SidebarInset>
          <SchedulerContentHeader
            selectedTaskName={selectedTask?.name}
            isRefreshing={isLoading}
            onCreate={handleCreateClick}
            onRefresh={handleRefresh}
            onExport={() => setShowExportDialog(true)}
            onImport={() => setShowImportDialog(true)}
            onOpenTemplates={() => setShowTemplateGallery(true)}
            onCleanup={handleCleanup}
          />

          <div className="flex-1 min-h-0 overflow-auto">
            {selectedTask ? (
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
              />
            ) : (
              <SchedulerDashboardView
                statistics={statistics}
                activeTasks={activeTasks}
                pausedTasks={pausedTasks}
                upcomingTasks={upcomingTasks}
                recentExecutions={recentExecutions}
                schedulerStatus={schedulerStatus}
                onSelectTask={handleSelectTask}
              />
            )}
          </div>
        </SidebarInset>
      </div>

      {/* Workflow / backup hidden dialogs intentionally omitted. */}

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
    </SidebarProvider>
  )
}
