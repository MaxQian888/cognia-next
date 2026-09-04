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
import type { CancelExecutionOutcome } from "@/lib/scheduler/task-scheduler"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { subscribeSchedulerHostTarget } from "@/lib/scheduler/scheduler-host-target"
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
let schedulerTargetUnsubscribe: (() => void) | null = null
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
  /**
   * OS promotion (desktop, local schedule only). See
   * `lib/scheduler/promote-to-system.ts` for the wake+delegate contract.
   */
  promoteTask: (
    taskId: string,
    opts?: { confirmed?: boolean; token?: string }
  ) => Promise<import("@/lib/scheduler/task-scheduler").PromoteTaskResult>
  /** Record a promotion after an out-of-band OS confirmation completed. */
  recordPromotion: (
    taskId: string,
    promotion: { systemTaskId: string; token: string; backend?: string }
  ) => Promise<boolean>
  unpromoteTask: (taskId: string) => Promise<boolean>
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

  /**
   * Stop a running execution of any task type.
   *
   * Supersedes `cancelPluginExecution` as the surface the panel calls. A
   * plugin run still ends through the plugin executor's own controller, which
   * is what {@link cancelPluginExecution} reaches, but every other type has
   * only ever been reachable through the scheduler's abort controller and so
   * had no cancel at all.
   */
  cancelExecution: (executionId: string) => Promise<CancelExecutionOutcome>

  // Plugin Execution Management
  cancelPluginExecution: (executionId: string) => boolean
  getActivePluginCount: () => number
  isPluginExecutionActive: (executionId: string) => boolean

  // Permission Management
  /** Hydrate {@link permissionPolicy} from `AppSettings`. Idempotent. */
  loadPermissionPolicy: () => Promise<void>
  updatePermissionPolicy: (update: Partial<SchedulerPermissionPolicy>) => void
  // There is deliberately no `checkPermission` here. The one that used to live
  // on this store had zero production callers while carrying tests, which made
  // an unenforced policy look verified. Enforcement is
  // `lib/scheduler/write-authority.ts`, which every write path calls, counts
  // per source off an index, and can answer "needs confirmation" as well as
  // yes/no.

  // System Status
  setSchedulerStatus: (status: SchedulerStatus) => void
  /**
   * Seconds between background refreshes of the app-scheduler slices; `0`
   * disables the poll. Persisted since the store shipped and read by
   * `useScheduler`, but there was no way to change it — Settings → Scheduled
   * tasks now owns the control.
   */
  setAutoRefreshInterval: (seconds: number) => void

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
          // The policy gate. Everything reaching this store from an agent, a
          // plugin, or a subsystem passes here; a person in the UI is never
          // gated. `createdBy` defaults to `{ kind: "user" }` in the
          // serializer, and the same default applies to the question of who is
          // asking, so an unattributed write is treated as the user's own.
          const { authorizeTaskWrite, verdictNeedsConfirmation } =
            await import("@/lib/scheduler/write-authority")
          const creator = input.createdBy
          const verdict = await authorizeTaskWrite({
            taskType: input.type,
            source: creator?.kind ?? "user",
            sessionId: creator?.sessionId,
            pluginId: creator?.pluginId,
          })
          if (!verdict.allowed) {
            set({ error: verdict.message })
            log.warn("SchedulerStore: create refused by policy", {
              type: input.type,
              reason: verdict.reason,
            })
            return null
          }
          if (verdictNeedsConfirmation(verdict)) {
            // The store cannot show a dialog, and guessing the user's answer is
            // the one thing this gate exists to prevent. Callers that CAN ask
            // (the create sheet, the built-in skills' confirm card) resolve the
            // confirmation first and then write as `user`.
            set({ error: verdict.message })
            log.warn("SchedulerStore: create needs confirmation", { type: input.type })
            return null
          }

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

      promoteTask: async (taskId, opts) => {
        // Promotion binds an OS timer on THIS machine to a task in THIS
        // machine's schedule; a remote host's schedule cannot be promoted from here.
        if (isRemoteHostActive()) {
          return {
            status: "unavailable",
            reason: "Promotion is only available for this device's own schedule.",
          }
        }
        try {
          const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
          const result = await getTaskScheduler().promoteTask(taskId, opts)
          if (result.status === "promoted") await get().refreshAll()
          return result
        } catch (error) {
          log.error("SchedulerStore: Promote task failed", error as Error)
          return {
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
          }
        }
      },

      recordPromotion: async (taskId, promotion) => {
        if (isRemoteHostActive()) return false
        try {
          const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
          const task = await getTaskScheduler().recordPromotion(taskId, promotion)
          if (task) await get().refreshAll()
          return task !== null
        } catch (error) {
          log.error("SchedulerStore: Record promotion failed", error as Error)
          return false
        }
      },

      unpromoteTask: async (taskId) => {
        if (isRemoteHostActive()) return false
        try {
          const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
          const task = await getTaskScheduler().unpromoteTask(taskId)
          if (task) await get().refreshAll()
          return task !== null
        } catch (error) {
          log.error("SchedulerStore: Un-promote task failed", error as Error)
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

      // ========== Execution Control ==========

      cancelExecution: async (executionId) => {
        // A plugin run is held by the plugin executor rather than by the
        // scheduler's controller map, so it is tried first. Asking the
        // scheduler about it would answer "not-owned-here" for a run this
        // process can in fact stop.
        if (isPluginTaskExecutionActive(executionId)) {
          const stopped = cancelPluginTaskExecution(executionId)
          if (stopped) return { cancelled: true }
        }
        try {
          const outcome = await getSchedulerDataSource().cancelExecution(executionId)
          if (outcome.cancelled) {
            // The run settles itself through its own `finally`. Reloading the
            // selected task's page is what puts the settled row in front of the
            // user without waiting for the next poll.
            const { selectedTaskId } = get()
            if (selectedTaskId) await get().loadTaskExecutions(selectedTaskId)
          }
          return outcome
        } catch (error) {
          log.error("SchedulerStore: Cancel execution failed", error as Error)
          return { cancelled: false, reason: "not-found" }
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

      /**
       * Hydrate the policy from the account database for DISPLAY.
       *
       * Deliberately not called from `initialize`: this store's copy is what
       * the settings card renders, and the enforcement path
       * (`lib/scheduler/write-authority.ts`) reads `AppSettings` directly at
       * check time instead. That keeps a long-lived tab from enforcing a stale
       * policy, and keeps a Dexie read out of the scheduler's boot ordering.
       *
       * Until it resolves the store serves `DEFAULT_PERMISSION_POLICY`, which
       * is the restrictive answer (`agentAutoCreate: false`).
       */
      loadPermissionPolicy: async () => {
        const { getSettings } = await import("@/lib/db/settings")
        const stored = await getSettings()
          .then((settings) => settings.schedulerPermissionPolicy)
          .catch(() => undefined)
        if (!stored) return
        // Merge over the defaults so a policy persisted before a new field
        // existed does not surface that field as `undefined`.
        set({ permissionPolicy: { ...DEFAULT_PERMISSION_POLICY, ...stored } })
      },

      updatePermissionPolicy: (update) => {
        const next = { ...get().permissionPolicy, ...update }
        set({ permissionPolicy: next })
        // Optimistic in-memory update, durable write behind it. The settings
        // card is a live control, and awaiting a Dexie round-trip per keystroke
        // would make the number input stutter.
        void import("@/lib/db/settings")
          .then(({ saveSettings }) => saveSettings({ schedulerPermissionPolicy: next }))
          .catch((error) => {
            log.error("scheduler.permissionPolicy.persistFailed", { error })
          })
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

      setAutoRefreshInterval: (seconds) => {
        // Clamped rather than validated: the only caller is a numeric input,
        // and a 1-second poll over Dexie + a paired-host RPC is a footgun.
        const clamped = Number.isFinite(seconds)
          ? Math.max(0, Math.min(3600, Math.round(seconds)))
          : 0
        set({ autoRefreshInterval: clamped })
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
            // Flipping the managed schedule (this device ↔ paired host) only
            // changes which data source the store reads; the local scheduler
            // keeps running its own table either way.
            if (!schedulerTargetUnsubscribe) {
              schedulerTargetUnsubscribe = subscribeSchedulerHostTarget(() => {
                if (!get().isInitialized) return
                set({ selectedTaskId: null })
                void get().refreshAll()
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
      // `permissionPolicy` is deliberately absent. It is a rule about what
      // agents and plugins may do on the user's behalf, so it belongs inside
      // the account (encrypted, backed up, per-account) rather than in this
      // machine's localStorage, where every account shared one copy. It lives
      // in `AppSettings.schedulerPermissionPolicy` and is hydrated by
      // `loadPermissionPolicy`. What stays here is view state.
      partialize: (state) => ({
        autoRefreshInterval: state.autoRefreshInterval,
        filter: state.filter,
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
