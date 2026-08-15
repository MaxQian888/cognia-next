/**
 * useScheduler Hook
 * Main hook for interacting with the scheduler system
 */

"use client"

import { useEffect, useRef } from "react"
import {
  useSchedulerStore,
  selectTasks,
  selectExecutions,
  selectStatistics,
  selectSelectedTaskId,
  selectSelectedTask,
  selectActiveTasks,
  selectPausedTasks,
  selectUpcomingTasks,
  selectRecentExecutions,
  selectSchedulerStatus,
  selectFilter,
  selectIsLoading,
  selectError,
  selectIsInitialized,
} from "@/stores/scheduler"

export function useScheduler() {
  const store = useSchedulerStore()
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Selectors
  const tasks = useSchedulerStore(selectTasks)
  const executions = useSchedulerStore(selectExecutions)
  const statistics = useSchedulerStore(selectStatistics)
  const selectedTaskId = useSchedulerStore(selectSelectedTaskId)
  const selectedTask = useSchedulerStore(selectSelectedTask)
  const activeTasks = useSchedulerStore(selectActiveTasks)
  const pausedTasks = useSchedulerStore(selectPausedTasks)
  const upcomingTasks = useSchedulerStore(selectUpcomingTasks)
  const recentExecutions = useSchedulerStore(selectRecentExecutions)
  const schedulerStatus = useSchedulerStore(selectSchedulerStatus)
  const filter = useSchedulerStore(selectFilter)
  const isLoading = useSchedulerStore(selectIsLoading)
  const error = useSchedulerStore(selectError)
  const isInitialized = useSchedulerStore(selectIsInitialized)
  const hasMoreExecutions = useSchedulerStore((s) => s.hasMoreExecutions)

  // Initialize on mount — store handles deduplication of concurrent calls
  useEffect(() => {
    if (!isInitialized) {
      store.initialize()
    }
  }, [isInitialized, store])

  // Real-time execution status updates via BroadcastChannel (debounced)
  const broadcastDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isInitialized) return

    let channel: BroadcastChannel | null = null
    try {
      channel = new BroadcastChannel("cognia-scheduler-executions")
      channel.onmessage = (event) => {
        if (event.data?.type === "execution-update") {
          // Debounce: coalesce rapid-fire updates into a single refresh
          if (broadcastDebounceRef.current) {
            clearTimeout(broadcastDebounceRef.current)
          }
          broadcastDebounceRef.current = setTimeout(() => {
            store.refreshAll()
            broadcastDebounceRef.current = null
          }, 300)
        }
      }
    } catch {
      // BroadcastChannel not available — fallback to polling
    }

    return () => {
      if (broadcastDebounceRef.current) {
        clearTimeout(broadcastDebounceRef.current)
      }
      try {
        channel?.close()
      } catch {
        /* ignore */
      }
    }
  }, [isInitialized, store])

  // Auto-refresh with visibility-aware polling (PERF-3)
  useEffect(() => {
    if (!isInitialized || store.autoRefreshInterval <= 0) return

    const startPolling = () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = setInterval(() => {
        store.refreshAll()
      }, store.autoRefreshInterval * 1000)
    }

    const stopPolling = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling()
      } else {
        // Refresh immediately when tab becomes visible, then restart polling
        store.refreshAll()
        startPolling()
      }
    }

    // Start polling only if tab is visible
    if (!document.hidden) {
      startPolling()
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      stopPolling()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [isInitialized, store, store.autoRefreshInterval])

  return {
    // State
    tasks,
    executions,
    statistics,
    selectedTaskId,
    selectedTask,
    activeTasks,
    pausedTasks,
    upcomingTasks,
    recentExecutions,
    schedulerStatus,
    filter,
    isLoading,
    error,
    isInitialized,
    hasMoreExecutions,

    // Actions — store methods are stable references, no useCallback needed
    createTask: store.createTask,
    updateTask: store.updateTask,
    deleteTask: store.deleteTask,
    pauseTask: store.pauseTask,
    resumeTask: store.resumeTask,
    promoteTask: store.promoteTask,
    recordPromotion: store.recordPromotion,
    unpromoteTask: store.unpromoteTask,
    runTaskNow: store.runTaskNow,
    backfillTask: store.backfillTask,
    selectTask: store.selectTask,
    setFilter: store.setFilter,
    clearFilter: store.clearFilter,
    refresh: store.refreshAll,
    clearError: store.clearError,
    loadMoreExecutions: store.loadMoreExecutions,
    loadRecentExecutions: store.loadRecentExecutions,
    loadUpcomingTasks: store.loadUpcomingTasks,
    cleanupOldExecutions: store.cleanupOldExecutions,
    cancelPluginExecution: store.cancelPluginExecution,
    getActivePluginCount: store.getActivePluginCount,
    isPluginExecutionActive: store.isPluginExecutionActive,

    // Import/Export & Clone
    exportTasks: store.exportTasks,
    importTasks: store.importTasks,
    cloneTask: store.cloneTask,

    // Bulk Operations
    bulkPause: store.bulkPause,
    bulkResume: store.bulkResume,
    bulkDelete: store.bulkDelete,
  }
}
