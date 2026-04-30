/**
 * Scheduler Store
 * Zustand store for managing scheduler state in the UI
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type {
  ScheduledTask,
  TaskExecution,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
  TaskFilter,
  TaskStatistics,
  SchedulerPermissionPolicy,
  TaskCreationSource,
  ScheduledTaskType,
} from "@/types/scheduler"
import { DEFAULT_PERMISSION_POLICY } from "@/types/scheduler"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import {
  cancelPluginTaskExecution,
  getActivePluginTaskCount,
  isPluginTaskExecutionActive,
} from "@/lib/scheduler/executors/plugin-executor"
import { loggers } from "@/lib/logger"

const log = loggers.store

// Deduplication guard for concurrent initialize() calls
let initPromise: Promise<void> | null = null

// Deduplication guard for concurrent refreshAll() calls
let refreshPromise: Promise<void> | null = null

// Scheduler system status
export type SchedulerStatus = "idle" | "running" | "stopped"

interface SchedulerState {
  // Data
  tasks: ScheduledTask[]
  executions: TaskExecution[]
  recentExecutions: TaskExecution[]
  upcomingTasks: ScheduledTask[]
  statistics: TaskStatistics | null

  // UI State
  selectedTaskId: string | null
  filter: TaskFilter
  isLoading: boolean
  error: string | null
  hasMoreExecutions: boolean
  executionsCursor: string | null

  // System State
  schedulerStatus: SchedulerStatus

  // Settings
  isInitialized: boolean
  autoRefreshInterval: number // in seconds, 0 = disabled
  permissionPolicy: SchedulerPermissionPolicy
}

interface SchedulerActions {
  // Task CRUD
  createTask: (input: CreateScheduledTaskInput) => Promise<ScheduledTask | null>
  updateTask: (taskId: string, input: UpdateScheduledTaskInput) => Promise<ScheduledTask | null>
  deleteTask: (taskId: string) => Promise<boolean>

  // Task Actions
  pauseTask: (taskId: string) => Promise<boolean>
  resumeTask: (taskId: string) => Promise<boolean>
  runTaskNow: (taskId: string) => Promise<TaskExecution | null>

  // Data Loading
  loadTasks: () => Promise<void>
  loadTaskExecutions: (taskId: string) => Promise<void>
  loadMoreExecutions: () => Promise<void>
  loadStatistics: () => Promise<void>
  loadRecentExecutions: (limit?: number) => Promise<void>
  loadUpcomingTasks: (limit?: number) => Promise<void>
  refreshAll: () => Promise<void>

  // Bulk Operations
  bulkPause: (taskIds: string[]) => Promise<number>
  bulkResume: (taskIds: string[]) => Promise<number>
  bulkDelete: (taskIds: string[]) => Promise<number>

  // Import/Export
  exportTasks: (taskIds?: string[]) => Promise<string>
  importTasks: (
    json: string,
    mode?: "merge" | "replace"
  ) => Promise<{ imported: number; skipped: number; errors: string[] }>

  // Clone
  cloneTask: (taskId: string) => Promise<ScheduledTask | null>

  // Maintenance
  cleanupOldExecutions: (maxAgeDays?: number) => Promise<number>

  // Plugin Execution Management
  cancelPluginExecution: (executionId: string) => boolean
  getActivePluginCount: () => number
  isPluginExecutionActive: (executionId: string) => boolean

  // Permission Management
  updatePermissionPolicy: (update: Partial<SchedulerPermissionPolicy>) => void
  checkPermission: (
    taskType: ScheduledTaskType,
    source: TaskCreationSource
  ) => { allowed: boolean; reason?: string }

  // System Status
  setSchedulerStatus: (status: SchedulerStatus) => void

  // UI Actions
  selectTask: (taskId: string | null) => void
  setTasks: (tasks: ScheduledTask[]) => void
  setFilter: (filter: Partial<TaskFilter>) => void
  clearFilter: () => void
  clearSelection: () => void
  setError: (error: string | null) => void
  clearError: () => void

  // Initialization
  initialize: () => Promise<void>

  // Reset
  reset: () => void
}

type SchedulerStore = SchedulerState & SchedulerActions

const initialState: SchedulerState = {
  tasks: [],
  executions: [],
  recentExecutions: [],
  upcomingTasks: [],
  statistics: null,
  selectedTaskId: null,
  filter: {},
  isLoading: false,
  error: null,
  hasMoreExecutions: true,
  executionsCursor: null,
  schedulerStatus: "idle",
  isInitialized: false,
  autoRefreshInterval: 60,
  permissionPolicy: DEFAULT_PERMISSION_POLICY,
}

const EXECUTIONS_PAGE_SIZE = 50

function sortTasksBySchedulerPriority(tasks: ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((a, b) => {
    if (a.status === "active" && b.status !== "active") return -1
    if (a.status !== "active" && b.status === "active") return 1
    if (a.nextRunAt && b.nextRunAt) {
      return a.nextRunAt.getTime() - b.nextRunAt.getTime()
    }
    if (a.nextRunAt) return -1
    if (b.nextRunAt) return 1
    return 0
  })
}

export const useSchedulerStore = create<SchedulerStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      // ========== Task CRUD ==========

      createTask: async (input) => {
        set({ isLoading: true, error: null })
        try {
          const scheduler = getTaskScheduler()
          const task = await scheduler.createTask(input)

          if (task) {
            await get().refreshAll()
          }

          return task
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Failed to create task"
          set({ error: errorMessage })
          log.error("SchedulerStore: Create task failed", error as Error)
          return null
        } finally {
          set({ isLoading: false })
        }
      },

      updateTask: async (taskId, input) => {
        set({ isLoading: true, error: null })
        try {
          const scheduler = getTaskScheduler()
          const task = await scheduler.updateTask(taskId, input)

          if (task) {
            await get().refreshAll()
          }

          return task
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Failed to update task"
          set({ error: errorMessage })
          log.error("SchedulerStore: Update task failed", error as Error)
          return null
        } finally {
          set({ isLoading: false })
        }
      },

      deleteTask: async (taskId) => {
        set({ isLoading: true, error: null })
        try {
          const scheduler = getTaskScheduler()
          const deleted = await scheduler.deleteTask(taskId)

          if (deleted) {
            const { selectedTaskId } = get()
            if (selectedTaskId === taskId) {
              set({ selectedTaskId: null, executions: [] })
            }
            await get().refreshAll()
          }

          return deleted
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Failed to delete task"
          set({ error: errorMessage })
          log.error("SchedulerStore: Delete task failed", error as Error)
          return false
        } finally {
          set({ isLoading: false })
        }
      },

      // ========== Task Actions ==========

      pauseTask: async (taskId) => {
        try {
          const scheduler = getTaskScheduler()
          const success = await scheduler.pauseTask(taskId)

          if (success) {
            await get().refreshAll()
          }

          return success
        } catch (error) {
          log.error("SchedulerStore: Pause task failed", error as Error)
          return false
        }
      },

      resumeTask: async (taskId) => {
        try {
          const scheduler = getTaskScheduler()
          const success = await scheduler.resumeTask(taskId)

          if (success) {
            await get().refreshAll()
          }

          return success
        } catch (error) {
          log.error("SchedulerStore: Resume task failed", error as Error)
          return false
        }
      },

      runTaskNow: async (taskId) => {
        set({ isLoading: true, error: null })
        try {
          const scheduler = getTaskScheduler()
          const execution = await scheduler.runTaskNow(taskId)

          if (execution) {
            await get().refreshAll()
          }

          return execution
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Failed to run task"
          set({ error: errorMessage })
          log.error("SchedulerStore: Run task failed", error as Error)
          return null
        } finally {
          set({ isLoading: false })
        }
      },

      // ========== Data Loading ==========

      loadTasks: async () => {
        try {
          const { filter } = get()
          let tasks: ScheduledTask[]

          if (Object.keys(filter).length > 0) {
            tasks = await schedulerDb.getFilteredTasks(filter)
          } else {
            tasks = await schedulerDb.getAllTasks()
          }

          set({ tasks: sortTasksBySchedulerPriority(tasks) })
        } catch (error) {
          log.error("SchedulerStore: Load tasks failed", error as Error)
          set({ error: "Failed to load tasks" })
        }
      },

      loadTaskExecutions: async (taskId) => {
        try {
          const executions = await schedulerDb.getTaskExecutions(taskId, EXECUTIONS_PAGE_SIZE)
          const cursor =
            executions.length > 0 ? executions[executions.length - 1].startedAt.toISOString() : null
          set({
            executions,
            hasMoreExecutions: executions.length >= EXECUTIONS_PAGE_SIZE,
            executionsCursor: cursor,
          })
        } catch (error) {
          log.error("SchedulerStore: Load executions failed", error as Error)
        }
      },

      loadMoreExecutions: async () => {
        const { selectedTaskId, executionsCursor, hasMoreExecutions } = get()
        if (!selectedTaskId || !executionsCursor || !hasMoreExecutions) return

        try {
          const moreExecutions = await schedulerDb.getTaskExecutions(
            selectedTaskId,
            EXECUTIONS_PAGE_SIZE,
            executionsCursor
          )
          const newCursor =
            moreExecutions.length > 0
              ? moreExecutions[moreExecutions.length - 1].startedAt.toISOString()
              : null
          set((state) => ({
            executions: [...state.executions, ...moreExecutions],
            hasMoreExecutions: moreExecutions.length >= EXECUTIONS_PAGE_SIZE,
            executionsCursor: newCursor,
          }))
        } catch (error) {
          log.error("SchedulerStore: Load more executions failed", error as Error)
        }
      },

      loadStatistics: async () => {
        try {
          const statistics = await schedulerDb.getStatistics()
          set({ statistics })
        } catch (error) {
          log.error("SchedulerStore: Load statistics failed", error as Error)
        }
      },

      loadRecentExecutions: async (limit = 50) => {
        try {
          const recentExecutions = await schedulerDb.getRecentExecutions(limit)
          set({ recentExecutions })
        } catch (error) {
          log.error("SchedulerStore: Load recent executions failed", error as Error)
        }
      },

      loadUpcomingTasks: async (limit = 10) => {
        try {
          const upcomingTasks = await schedulerDb.getUpcomingTasks(limit)
          set({ upcomingTasks })
        } catch (error) {
          log.error("SchedulerStore: Load upcoming tasks failed", error as Error)
        }
      },

      refreshAll: async () => {
        // Deduplicate concurrent refreshAll calls
        if (refreshPromise) return refreshPromise

        refreshPromise = (async () => {
          set({ isLoading: true })
          try {
            const { filter, selectedTaskId } = get()

            // Fetch all data in parallel
            const [tasks, statistics, executions, recentExecutions, upcomingTasks] =
              await Promise.all([
                Object.keys(filter).length > 0
                  ? schedulerDb.getFilteredTasks(filter)
                  : schedulerDb.getAllTasks(),
                schedulerDb.getStatistics(),
                selectedTaskId
                  ? schedulerDb.getTaskExecutions(selectedTaskId, EXECUTIONS_PAGE_SIZE)
                  : Promise.resolve(get().executions),
                schedulerDb.getRecentExecutions(50),
                schedulerDb.getUpcomingTasks(10),
              ])

            const cursor =
              executions.length > 0
                ? executions[executions.length - 1].startedAt.toISOString()
                : null

            // Single batched state update
            set({
              tasks: sortTasksBySchedulerPriority(tasks),
              statistics,
              executions,
              recentExecutions,
              upcomingTasks,
              hasMoreExecutions: executions.length >= EXECUTIONS_PAGE_SIZE,
              executionsCursor: cursor,
              isLoading: false,
            })
          } catch (error) {
            log.error("SchedulerStore: Refresh all failed", error as Error)
            set({ error: "Failed to refresh scheduler data", isLoading: false })
          } finally {
            refreshPromise = null
          }
        })()

        return refreshPromise
      },

      // ========== UI Actions ==========

      selectTask: (taskId) => {
        set({ selectedTaskId: taskId, executions: [] })
        if (taskId) {
          get().loadTaskExecutions(taskId)
        }
      },

      setFilter: (filter) => {
        set((state) => ({
          filter: { ...state.filter, ...filter },
        }))
        void get().refreshAll()
      },

      clearFilter: () => {
        set({ filter: {} })
        void get().refreshAll()
      },

      setTasks: (tasks) => {
        set({ tasks })
      },

      clearSelection: () => {
        set({ selectedTaskId: null, executions: [] })
      },

      setError: (error) => {
        set({ error })
      },

      clearError: () => {
        set({ error: null })
      },

      // ========== Bulk Operations ==========

      bulkPause: async (taskIds) => {
        let count = 0
        try {
          const scheduler = getTaskScheduler()
          for (const taskId of taskIds) {
            const success = await scheduler.pauseTask(taskId)
            if (success) count++
          }
          if (count > 0) {
            log.info(`SchedulerStore: Bulk paused ${count}/${taskIds.length} tasks`)
            await get().refreshAll()
          }
        } catch (error) {
          log.error("SchedulerStore: Bulk pause failed", error as Error)
          set({ error: "Failed to pause tasks" })
        }
        return count
      },

      bulkResume: async (taskIds) => {
        let count = 0
        try {
          const scheduler = getTaskScheduler()
          for (const taskId of taskIds) {
            const success = await scheduler.resumeTask(taskId)
            if (success) count++
          }
          if (count > 0) {
            log.info(`SchedulerStore: Bulk resumed ${count}/${taskIds.length} tasks`)
            await get().refreshAll()
          }
        } catch (error) {
          log.error("SchedulerStore: Bulk resume failed", error as Error)
          set({ error: "Failed to resume tasks" })
        }
        return count
      },

      bulkDelete: async (taskIds) => {
        let count = 0
        try {
          const scheduler = getTaskScheduler()
          for (const taskId of taskIds) {
            const success = await scheduler.deleteTask(taskId)
            if (success) count++
          }
          if (count > 0) {
            log.info(`SchedulerStore: Bulk deleted ${count}/${taskIds.length} tasks`)
            // Clear selection if selected task was deleted
            const { selectedTaskId } = get()
            if (selectedTaskId && taskIds.includes(selectedTaskId)) {
              set({ selectedTaskId: null, executions: [] })
            }
            await get().refreshAll()
          }
        } catch (error) {
          log.error("SchedulerStore: Bulk delete failed", error as Error)
          set({ error: "Failed to delete tasks" })
        }
        return count
      },

      // ========== Import/Export ==========

      exportTasks: async (taskIds) => {
        try {
          const scheduler = getTaskScheduler()
          const data = await scheduler.exportTasks(taskIds)
          return JSON.stringify(data, null, 2)
        } catch (error) {
          log.error("SchedulerStore: Export tasks failed", error as Error)
          set({ error: "Failed to export tasks" })
          return "{}"
        }
      },

      importTasks: async (json, mode = "merge") => {
        set({ isLoading: true, error: null })
        try {
          const data = JSON.parse(json)
          const scheduler = getTaskScheduler()
          const result = await scheduler.importTasks(data, mode)
          if (result.imported > 0) {
            await get().refreshAll()
          }
          if (result.errors.length > 0) {
            set({ error: `Import completed with ${result.errors.length} error(s)` })
          }
          return result
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Failed to import tasks"
          log.error("SchedulerStore: Import tasks failed", error as Error)
          set({ error: msg })
          return { imported: 0, skipped: 0, errors: [msg] }
        } finally {
          set({ isLoading: false })
        }
      },

      // ========== Clone ==========

      cloneTask: async (taskId) => {
        try {
          const scheduler = getTaskScheduler()
          const originalTask = await scheduler.getTask(taskId)
          if (!originalTask) {
            set({ error: "Task not found" })
            return null
          }
          const clonedTask = await scheduler.createTask({
            name: `${originalTask.name} (Copy)`,
            description: originalTask.description,
            type: originalTask.type,
            trigger: originalTask.trigger,
            payload: originalTask.payload,
            config: originalTask.config,
            notification: originalTask.notification,
            tags: originalTask.tags,
          })
          await get().refreshAll()
          return clonedTask
        } catch (error) {
          log.error("SchedulerStore: Clone task failed", error as Error)
          set({ error: "Failed to clone task" })
          return null
        }
      },

      // ========== Maintenance ==========

      cleanupOldExecutions: async (maxAgeDays = 30) => {
        try {
          const deleted = await schedulerDb.cleanupOldExecutions(maxAgeDays)
          if (deleted > 0) {
            log.info(`SchedulerStore: Cleaned up ${deleted} old executions`)
            await get().refreshAll()
          }
          return deleted
        } catch (error) {
          log.error("SchedulerStore: Cleanup old executions failed", error as Error)
          return 0
        }
      },

      // ========== Plugin Execution Management ==========

      cancelPluginExecution: (executionId) => {
        return cancelPluginTaskExecution(executionId)
      },

      getActivePluginCount: () => {
        return getActivePluginTaskCount()
      },

      isPluginExecutionActive: (executionId) => {
        return isPluginTaskExecutionActive(executionId)
      },

      // ========== Permission Management ==========

      updatePermissionPolicy: (update) => {
        set((state) => ({
          permissionPolicy: { ...state.permissionPolicy, ...update },
        }))
      },

      checkPermission: (taskType, source) => {
        const policy = get().permissionPolicy

        // User source is always allowed
        if (source === "user") return { allowed: true }

        // Check if script tasks are disabled
        if (taskType === "script" && !policy.scriptTasksEnabled) {
          return { allowed: false, reason: "Script tasks are disabled in permission policy" }
        }

        // Check task count limit per source
        const sourceTaskCount = get().tasks.filter(() => true).length // all tasks (no per-source tracking yet)
        if (sourceTaskCount >= policy.maxTasksPerSource) {
          return {
            allowed: false,
            reason: `Maximum task limit (${policy.maxTasksPerSource}) reached`,
          }
        }

        // Agent source: check agentAutoCreate
        if (source === "agent" && !policy.agentAutoCreate) {
          if (policy.confirmationRequired.includes(taskType)) {
            return {
              allowed: false,
              reason: "Agent task creation requires user confirmation for this task type",
            }
          }
        }

        return { allowed: true }
      },

      // ========== System Status ==========

      setSchedulerStatus: (status) => {
        set({ schedulerStatus: status })
      },

      // ========== Initialization ==========

      initialize: async () => {
        if (get().isInitialized) return

        // Deduplicate concurrent calls (SchedulerInitializer + useScheduler may both call)
        if (initPromise) return initPromise

        initPromise = (async () => {
          set({ isLoading: true })
          try {
            const { initSchedulerSystem } = await import("@/lib/scheduler")
            await initSchedulerSystem()

            // Load initial data
            await get().refreshAll()

            set({ isInitialized: true })
          } catch (error) {
            log.error("SchedulerStore: Initialization failed", error as Error)
            set({ error: "Failed to initialize scheduler" })
          } finally {
            set({ isLoading: false })
            initPromise = null
          }
        })()

        return initPromise
      },

      // ========== Reset ==========

      reset: () => {
        set(initialState)
      },
    }),
    {
      name: "cognia-scheduler",
      partialize: (state) => ({
        autoRefreshInterval: state.autoRefreshInterval,
        filter: state.filter,
        permissionPolicy: state.permissionPolicy,
      }),
    }
  )
)

// ========== Selectors ==========

export const selectTasks = (state: SchedulerStore) => state.tasks
export const selectExecutions = (state: SchedulerStore) => state.executions
export const selectStatistics = (state: SchedulerStore) => state.statistics
export const selectSelectedTaskId = (state: SchedulerStore) => state.selectedTaskId
export const selectFilter = (state: SchedulerStore) => state.filter
export const selectIsLoading = (state: SchedulerStore) => state.isLoading
export const selectError = (state: SchedulerStore) => state.error
export const selectIsInitialized = (state: SchedulerStore) => state.isInitialized

export const selectSelectedTask = (state: SchedulerStore): ScheduledTask | undefined =>
  state.tasks.find((t) => t.id === state.selectedTaskId)

/**
 * Generic memoized selector factory — caches derived result based on source array reference.
 * Returns the same result array when the source hasn't changed, preventing infinite re-render loops.
 */
function createDerivedSelector<TSource, TResult>(
  getSource: (state: SchedulerStore) => TSource[],
  derive: (source: TSource[]) => TResult[]
): (state: SchedulerStore) => TResult[] {
  let cachedSource: TSource[] = []
  let cachedResult: TResult[] = []
  return (state: SchedulerStore) => {
    const source = getSource(state)
    if (source !== cachedSource) {
      cachedSource = source
      cachedResult = derive(source)
    }
    return cachedResult
  }
}

export const selectActiveTasks = createDerivedSelector(
  (s) => s.tasks,
  (tasks) => tasks.filter((t) => t.status === "active")
)

export const selectPausedTasks = createDerivedSelector(
  (s) => s.tasks,
  (tasks) => tasks.filter((t) => t.status === "paused")
)

export const selectUpcomingTasks = createDerivedSelector(
  (s) => s.tasks,
  (tasks) => {
    const now = new Date()
    return tasks
      .filter((t) => t.status === "active" && t.nextRunAt && t.nextRunAt > now)
      .sort((a, b) => (a.nextRunAt?.getTime() || 0) - (b.nextRunAt?.getTime() || 0))
      .slice(0, 5)
  }
)

export const selectRecentExecutions = (state: SchedulerStore): TaskExecution[] =>
  state.recentExecutions

export const selectSchedulerStatus = (state: SchedulerStore): SchedulerStatus =>
  state.schedulerStatus
