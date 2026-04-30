/**
 * System Scheduler Hook
 *
 * React hook for managing system-level scheduled tasks.
 * Provides state management and actions for the system scheduler.
 */

import { useCallback, useEffect, useState } from "react"

import { isTauri } from "@/lib/tauri"
import * as systemScheduler from "@/lib/native/system-scheduler"
import type {
  CreateSystemTaskInput,
  SchedulerCapabilities,
  SystemTask,
  SystemTaskId,
  TaskConfirmationRequest,
  TaskOperationResponse,
  TaskRunResult,
  ValidationResult,
} from "@/types/scheduler"
import {
  isTaskOperationSuccess,
  isConfirmationRequired,
  isTaskOperationError,
} from "@/types/scheduler"

export interface UseSystemSchedulerState {
  /** Scheduler capabilities */
  capabilities: SchedulerCapabilities | null
  /** Whether scheduler is available */
  isAvailable: boolean
  /** Whether running with elevated privileges */
  isElevated: boolean
  /** List of system tasks */
  tasks: SystemTask[]
  /** Current pending confirmation */
  pendingConfirmation: TaskConfirmationRequest | null
  /** Pending confirmation queue */
  pendingConfirmations: TaskConfirmationRequest[]
  /** Loading state */
  loading: boolean
  /** Error message */
  error: string | null
}

export interface UseSystemSchedulerActions {
  /** Refresh capabilities and task list */
  refresh: () => Promise<void>
  /** Create a new system task */
  createTask: (input: CreateSystemTaskInput, confirmed?: boolean) => Promise<TaskOperationResponse>
  /** Update an existing task */
  updateTask: (
    taskId: SystemTaskId,
    input: CreateSystemTaskInput,
    confirmed?: boolean
  ) => Promise<TaskOperationResponse>
  /** Delete a task */
  deleteTask: (taskId: SystemTaskId) => Promise<boolean>
  /** Enable a task */
  enableTask: (taskId: SystemTaskId) => Promise<boolean>
  /** Disable a task */
  disableTask: (taskId: SystemTaskId) => Promise<boolean>
  /** Run a task immediately */
  runTaskNow: (taskId: SystemTaskId) => Promise<TaskRunResult>
  /** Confirm current pending operation */
  confirmPending: () => Promise<void>
  /** Confirm a specific pending confirmation by ID */
  confirmTask: (confirmationId: string) => Promise<SystemTask | null>
  /** Cancel pending confirmation */
  cancelPending: () => void
  /** Validate task input */
  validateTask: (input: CreateSystemTaskInput) => Promise<ValidationResult>
  /** Request admin elevation */
  requestElevation: () => Promise<boolean>
  /** Get pre-filled input for duplicating a degraded task */
  duplicateTask: (taskId: SystemTaskId) => Promise<CreateSystemTaskInput | null>
  /** Delete and recreate a degraded task from stored metadata */
  recreateTask: (taskId: SystemTaskId) => Promise<TaskOperationResponse>
  /** Clear error */
  clearError: () => void
}

export type UseSystemSchedulerReturn = UseSystemSchedulerState & UseSystemSchedulerActions

/**
 * Hook for system scheduler operations
 */
export function useSystemScheduler(): UseSystemSchedulerReturn {
  const [capabilities, setCapabilities] = useState<SchedulerCapabilities | null>(null)
  const [isAvailable, setIsAvailable] = useState(false)
  const [isElevated, setIsElevated] = useState(false)
  const [tasks, setTasks] = useState<SystemTask[]>([])
  const [pendingConfirmation, setPendingConfirmation] = useState<TaskConfirmationRequest | null>(
    null
  )
  const [pendingConfirmations, setPendingConfirmations] = useState<TaskConfirmationRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const syncPendingQueue = useCallback((queue: TaskConfirmationRequest[]) => {
    const sorted = [...queue].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))
    setPendingConfirmations(sorted)
    setPendingConfirmation(sorted[0] || null)
  }, [])

  const refreshPendingQueue = useCallback(async () => {
    const queue = await systemScheduler.getPendingConfirmations()
    syncPendingQueue(queue)
  }, [syncPendingQueue])

  const refresh = useCallback(async () => {
    if (!isTauri()) return

    // Yield to a microtask so all setState calls happen asynchronously —
    // the rule against synchronous setState-in-effect is satisfied because
    // nothing here runs in the same tick as the effect body.
    await Promise.resolve()
    setLoading(true)
    setError(null)

    try {
      const [caps, available, elevated, taskList, pendingQueue] = await Promise.all([
        systemScheduler.getSchedulerCapabilities(),
        systemScheduler.isSchedulerAvailable(),
        systemScheduler.isSchedulerElevated(),
        systemScheduler.listSystemTasks(),
        systemScheduler.getPendingConfirmations(),
      ])

      setCapabilities(caps)
      setIsAvailable(available)
      setIsElevated(elevated)
      setTasks(taskList)
      syncPendingQueue(pendingQueue)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [syncPendingQueue])

  // Initial load — schedule `refresh` on a microtask via Promise.then so the
  // effect body never traces synchronously into a setState. `refresh` itself
  // also yields a microtask before calling setState.
  useEffect(() => {
    if (!isTauri()) return
    Promise.resolve().then(refresh)
  }, [refresh])

  const createTask = useCallback(
    async (input: CreateSystemTaskInput, confirmed = false): Promise<TaskOperationResponse> => {
      setLoading(true)
      setError(null)

      try {
        const response = await systemScheduler.createSystemTask(input, confirmed)

        if (isTaskOperationSuccess(response)) {
          setTasks((prev) => [...prev, response.task])
          await refresh()
        } else if (isConfirmationRequired(response)) {
          await refreshPendingQueue()
        } else if (isTaskOperationError(response)) {
          setError(response.message)
        }

        return response
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        return { status: "error", message }
      } finally {
        setLoading(false)
      }
    },
    [refresh, refreshPendingQueue]
  )

  const updateTask = useCallback(
    async (
      taskId: SystemTaskId,
      input: CreateSystemTaskInput,
      confirmed = false
    ): Promise<TaskOperationResponse> => {
      setLoading(true)
      setError(null)

      try {
        const response = await systemScheduler.updateSystemTask(taskId, input, confirmed)

        if (isTaskOperationSuccess(response)) {
          setTasks((prev) => prev.map((t) => (t.id === taskId ? response.task : t)))
          await refresh()
        } else if (isConfirmationRequired(response)) {
          await refreshPendingQueue()
        } else if (isTaskOperationError(response)) {
          setError(response.message)
        }

        return response
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        return { status: "error", message }
      } finally {
        setLoading(false)
      }
    },
    [refresh, refreshPendingQueue]
  )

  const deleteTask = useCallback(
    async (taskId: SystemTaskId): Promise<boolean> => {
      setLoading(true)
      setError(null)

      try {
        const result = await systemScheduler.deleteSystemTask(taskId)
        if (result) {
          await refresh()
        }
        return result
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setLoading(false)
      }
    },
    [refresh]
  )

  const enableTask = useCallback(
    async (taskId: SystemTaskId): Promise<boolean> => {
      setLoading(true)
      setError(null)

      try {
        const result = await systemScheduler.enableSystemTask(taskId)
        if (result) {
          await refresh()
        }
        return result
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setLoading(false)
      }
    },
    [refresh]
  )

  const disableTask = useCallback(
    async (taskId: SystemTaskId): Promise<boolean> => {
      setLoading(true)
      setError(null)

      try {
        const result = await systemScheduler.disableSystemTask(taskId)
        if (result) {
          await refresh()
        }
        return result
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setLoading(false)
      }
    },
    [refresh]
  )

  const runTaskNow = useCallback(
    async (taskId: SystemTaskId): Promise<TaskRunResult> => {
      setLoading(true)
      setError(null)

      try {
        const result = await systemScheduler.runSystemTaskNow(taskId)
        await refresh()
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        return {
          success: false,
          error: message,
        }
      } finally {
        setLoading(false)
      }
    },
    [refresh]
  )

  const duplicateTask = useCallback(
    async (taskId: SystemTaskId): Promise<CreateSystemTaskInput | null> => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return null
      return {
        name: `${task.name} (copy)`,
        description: task.description,
        trigger: task.trigger,
        action: task.action,
        run_level: task.run_level,
        tags: task.tags,
      }
    },
    [tasks]
  )

  const recreateTask = useCallback(
    async (taskId: SystemTaskId): Promise<TaskOperationResponse> => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) {
        return { status: "error", message: "Task not found" }
      }
      const input: CreateSystemTaskInput = {
        name: task.name,
        description: task.description,
        trigger: task.trigger,
        action: task.action,
        run_level: task.run_level,
        tags: task.tags,
      }
      const deleted = await deleteTask(taskId)
      if (!deleted) {
        return { status: "error", message: "Failed to delete degraded task" }
      }
      return createTask(input)
    },
    [tasks, deleteTask, createTask]
  )

  const confirmTask = useCallback(
    async (confirmationId: string): Promise<SystemTask | null> => {
      try {
        setLoading(true)
        const result = await systemScheduler.confirmSystemTask(confirmationId)
        if (result) {
          setTasks((prev) => {
            const exists = prev.some((task) => task.id === result.id)
            if (exists) {
              return prev.map((task) => (task.id === result.id ? result : task))
            }
            return [...prev, result]
          })
        }
        await refresh()
        return result
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setLoading(false)
      }
    },
    [refresh]
  )

  const confirmPending = useCallback(async () => {
    const confirmationId = pendingConfirmation?.confirmation_id || pendingConfirmation?.task_id
    if (!confirmationId) return
    await confirmTask(confirmationId)
  }, [confirmTask, pendingConfirmation])

  const cancelPending = useCallback(() => {
    const confirmationId = pendingConfirmation?.confirmation_id || pendingConfirmation?.task_id
    if (!confirmationId) {
      return
    }
    void systemScheduler
      .cancelTaskConfirmation(confirmationId)
      .then(async () => {
        await refreshPendingQueue()
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [pendingConfirmation, refreshPendingQueue])

  const validateTask = useCallback(
    async (input: CreateSystemTaskInput): Promise<ValidationResult> => {
      return systemScheduler.validateSystemTask(input)
    },
    []
  )

  const requestElevation = useCallback(async (): Promise<boolean> => {
    try {
      return await systemScheduler.requestSchedulerElevation()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    // State
    capabilities,
    isAvailable,
    isElevated,
    tasks,
    pendingConfirmation,
    pendingConfirmations,
    loading,
    error,
    // Actions
    refresh,
    createTask,
    updateTask,
    deleteTask,
    enableTask,
    disableTask,
    runTaskNow,
    confirmPending,
    confirmTask,
    cancelPending,
    validateTask,
    requestElevation,
    duplicateTask,
    recreateTask,
    clearError,
  }
}
