/**
 * Scheduler Store
 * Zustand store for managing scheduler state in the UI
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
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
  TaskExecutionTriggerSource,
} from "@/types/scheduler"
import { DEFAULT_PERMISSION_POLICY } from "@/types/scheduler"
import { getSchedulerDataSource } from "@/lib/scheduler/scheduler-data-source"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import {
  cancelPluginTaskExecution,
  getActivePluginTaskCount,
  isPluginTaskExecutionActive,
} from "@/lib/scheduler/executors/plugin-executor"
import { loggers } from "@cognia/logging"

const log = loggers.store

// Deduplication guard for concurrent initialize() calls
let initPromise: Promise<void> | null = null
// Invalidates an async initialize() when the runtime is stopped before it settles.
let initializationGeneration = 0

// Deduplication guard for concurrent refreshAll() calls
let refreshPromise: Promise<void> | null = null
let schedulerRoutingUnsubscribe: (() => void) | null = null
let schedulerHostGeneration = 0

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
  /**
   * Multi-select set for the unified scheduler page's bulk-action toolbar.
   * Persisted as `string[]` (Zustand persist middleware can't round-trip
   * `Set`s through JSON); the API surface still uses Set-like semantics via
   * helper actions.
   */
  multiSelection: string[]
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
  runTaskNow: (
    taskId: string,
    opts?: { triggerSource?: TaskExecutionTriggerSource }
  ) => Promise<TaskExecution | null>
  /** Re-run past schedule slots in [start, end]; resolves with the run count. */
  backfillTask: (taskId: string, range: { start: Date; end: Date }) => Promise<number>

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
  /** Toggle the unifiedId in/out of the multi-select set. */
  toggleMultiSelection: (unifiedId: string) => void
  /** Clear the multi-select set. */
  clearMultiSelection: () => void
  /** Replace the multi-select set wholesale (used by 'select all'). */
  setMultiSelection: (unifiedIds: string[]) => void
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
  multiSelection: [],
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
          const task = await getSchedulerDataSource().createTask(input)

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
          const taskType = get().tasks.find((task) => task.id === taskId)?.type
          const task = await getSchedulerDataSource().updateTask(taskId, input, taskType)

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
          const taskType = get().tasks.find((task) => task.id === taskId)?.type
          const deleted = await getSchedulerDataSource().deleteTask(taskId, taskType)

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
          const taskType = get().tasks.find((task) => task.id === taskId)?.type
          const success = await getSchedulerDataSource().pauseTask(taskId, taskType)

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
          const taskType = get().tasks.find((task) => task.id === taskId)?.type
          const success = await getSchedulerDataSource().resumeTask(taskId, taskType)

          if (success) {
            await get().refreshAll()
          }

          return success
        } catch (error) {
          log.error("SchedulerStore: Resume task failed", error as Error)
          return false
        }
      },

      runTaskNow: async (taskId, opts) => {
        set({ isLoading: true, error: null })
        try {
          const taskType = get().tasks.find((task) => task.id === taskId)?.type
          const execution = await getSchedulerDataSource().runTaskNow(taskId, {
            ...opts,
            taskType,
          })

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

      backfillTask: async (taskId, range) => {
        set({ isLoading: true, error: null })
        try {
          const executions = await getSchedulerDataSource().backfillTask(taskId, range)
          if (executions.length > 0) {
            await get().refreshAll()
          }
          return executions.length
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Failed to backfill task"
          set({ error: errorMessage })
          log.error("SchedulerStore: Backfill failed", error as Error)
          throw error
        } finally {
          set({ isLoading: false })
        }
      },

      // ========== Data Loading ==========

      loadTasks: async () => {
        try {
          const { filter } = get()
          const tasks = await getSchedulerDataSource().listTasks(filter)
          set({ tasks: sortTasksBySchedulerPriority(tasks) })
        } catch (error) {
          log.error("SchedulerStore: Load tasks failed", error as Error)
          set({ error: "Failed to load tasks" })
        }
      },

      loadTaskExecutions: async (taskId) => {
        try {
          const executions = await getSchedulerDataSource().getTaskExecutions(
            taskId,
            EXECUTIONS_PAGE_SIZE,
            undefined,
            get().tasks.find((task) => task.id === taskId)?.type
          )
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
          const moreExecutions = await getSchedulerDataSource().getTaskExecutions(
            selectedTaskId,
            EXECUTIONS_PAGE_SIZE,
            executionsCursor,
            get().tasks.find((task) => task.id === selectedTaskId)?.type
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
          const statistics = await getSchedulerDataSource().getStatistics()
          set({ statistics })
        } catch (error) {
          log.error("SchedulerStore: Load statistics failed", error as Error)
        }
      },

      loadRecentExecutions: async (limit = 50) => {
        try {
          const recentExecutions = await getSchedulerDataSource().getRecentExecutions(limit)
          set({ recentExecutions })
        } catch (error) {
          log.error("SchedulerStore: Load recent executions failed", error as Error)
        }
      },

      loadUpcomingTasks: async (limit = 10) => {
        try {
          const upcomingTasks = await getSchedulerDataSource().getUpcomingTasks(limit)
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
            const source = getSchedulerDataSource()

            // Fetch all data in parallel
            const [tasks, statistics, executions, recentExecutions, upcomingTasks] =
              await Promise.all([
                source.listTasks(filter),
                source.getStatistics(),
                selectedTaskId
                  ? source.getTaskExecutions(
                      selectedTaskId,
                      EXECUTIONS_PAGE_SIZE,
                      undefined,
                      get().tasks.find((task) => task.id === selectedTaskId)?.type
                    )
                  : Promise.resolve(get().executions),
                source.getRecentExecutions(50),
                source.getUpcomingTasks(10),
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

      toggleMultiSelection: (unifiedId: string) => {
        const current = get().multiSelection
        const next = current.includes(unifiedId)
          ? current.filter((id) => id !== unifiedId)
          : [...current, unifiedId]
        set({ multiSelection: next })
      },

      clearMultiSelection: () => {
        set({ multiSelection: [] })
      },

      setMultiSelection: (unifiedIds: string[]) => {
        // Dedup while preserving insertion order
        set({ multiSelection: Array.from(new Set(unifiedIds)) })
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
          const source = getSchedulerDataSource()
          for (const taskId of taskIds) {
            const taskType = get().tasks.find((task) => task.id === taskId)?.type
            const success = await source.pauseTask(taskId, taskType)
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
          const source = getSchedulerDataSource()
          for (const taskId of taskIds) {
            const taskType = get().tasks.find((task) => task.id === taskId)?.type
            const success = await source.resumeTask(taskId, taskType)
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
          const source = getSchedulerDataSource()
          for (const taskId of taskIds) {
            const taskType = get().tasks.find((task) => task.id === taskId)?.type
            const success = await source.deleteTask(taskId, taskType)
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
          const data = await getSchedulerDataSource().exportTasks(taskIds)
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
          const result = await getSchedulerDataSource().importTasks(data, mode)
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
          const source = getSchedulerDataSource()
          const originalTask = await source.getTask(taskId)
          if (!originalTask) {
            set({ error: "Task not found" })
            return null
          }
          const clonedTask = await source.createTask({
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
          const deleted = await getSchedulerDataSource().cleanupOldExecutions(maxAgeDays)
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
        if (status === "stopped") {
          initializationGeneration += 1
          initPromise = null
          set({ schedulerStatus: status, isInitialized: false, isLoading: false })
          return
        }
        set({ schedulerStatus: status })
      },

      // ========== Initialization ==========

      initialize: async () => {
        if (get().isInitialized) return

        // Deduplicate concurrent calls (SchedulerInitializer + useScheduler may both call)
        if (initPromise) return initPromise

        const generation = initializationGeneration
        const currentPromise = (async () => {
          set({ isLoading: true })
          try {
            const { initSchedulerSystem, stopSchedulerSystem } = await import("@/lib/scheduler")
            if (isRemoteHostActive()) {
              await stopSchedulerSystem()
            } else {
              await initSchedulerSystem()
            }
            if (generation !== initializationGeneration) return

            // Load initial data
            await get().refreshAll()
            if (generation !== initializationGeneration) return

            set({ isInitialized: true })
            if (!schedulerRoutingUnsubscribe) {
              schedulerRoutingUnsubscribe = subscribeActiveRemoteTransport(() => {
                void rebindSchedulerHost()
              })
            }
          } catch (error) {
            if (generation === initializationGeneration) {
              log.error("SchedulerStore: Initialization failed", error as Error)
              set({ error: "Failed to initialize scheduler" })
            }
            throw error
          } finally {
            if (generation === initializationGeneration) {
              set({ isLoading: false })
            }
          }
        })()
        initPromise = currentPromise

        try {
          await currentPromise
        } finally {
          if (initPromise === currentPromise) {
            initPromise = null
          }
        }
      },

      // ========== Reset ==========

      reset: () => {
        initializationGeneration += 1
        initPromise = null
        set(initialState)
      },
    }),
    {
      name: "cognia-scheduler",
      storage: persistLocalStorage(),
      partialize: (state) => ({
        autoRefreshInterval: state.autoRefreshInterval,
        filter: state.filter,
        permissionPolicy: state.permissionPolicy,
      }),
    }
  )
)

async function rebindSchedulerHost(): Promise<void> {
  if (!useSchedulerStore.getState().isInitialized) return
  const generation = ++schedulerHostGeneration
  const remote = isRemoteHostActive()
  const { initSchedulerSystem, stopSchedulerSystem } = await import("@/lib/scheduler")
  await stopSchedulerSystem()
  if (!remote) await initSchedulerSystem()
  if (generation !== schedulerHostGeneration || remote !== isRemoteHostActive()) return
  await useSchedulerStore.getState().refreshAll()
}

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
