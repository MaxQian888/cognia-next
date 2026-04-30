/**
 * Scheduler Database
 * Dexie-based persistence for scheduled tasks and executions
 */

import Dexie, { type EntityTable } from "dexie"
import type {
  ScheduledTask,
  TaskExecution,
  ScheduledTaskStatus,
  TaskFilter,
  TaskStatistics,
} from "@/types/scheduler"
import { loggers } from "@/lib/logger"

const log = loggers.app

// Database entity types (stored format)
interface DBScheduledTask {
  id: string
  name: string
  description?: string
  type: string
  trigger: string // JSON serialized TaskTrigger
  payload: string // JSON serialized Record<string, unknown>
  config: string // JSON serialized TaskExecutionConfig
  notification: string // JSON serialized TaskNotificationConfig
  status: string
  tags?: string // JSON serialized string[]
  lastRunAt?: string // ISO date string
  nextRunAt?: string // ISO date string
  runCount: number
  successCount: number
  failureCount: number
  lastError?: string
  lastTerminalReason?: string
  lastTerminalAt?: string // ISO date string
  createdAt: string // ISO date string
  updatedAt: string // ISO date string
}

interface DBTaskExecution {
  id: string
  taskId: string
  taskName: string
  taskType: string
  status: string
  input?: string // JSON serialized
  output?: string // JSON serialized
  error?: string
  retryAttempt: number
  duration?: number
  scheduledFor?: string // ISO date string
  triggerSource?: string
  terminalReason?: string
  retryScheduledAt?: string // ISO date string
  startedAt: string // ISO date string
  completedAt?: string // ISO date string
  logs: string // JSON serialized TaskExecutionLog[]
}

// Database class
class SchedulerDatabase extends Dexie {
  tasks!: EntityTable<DBScheduledTask, "id">
  executions!: EntityTable<DBTaskExecution, "id">

  constructor() {
    super("CogniaSchedulerDB")

    this.version(1).stores({
      tasks: "id, name, type, status, nextRunAt, createdAt, [status+nextRunAt]",
      executions: "id, taskId, status, startedAt, [taskId+startedAt]",
    })

    this.version(2).stores({
      tasks: "id, name, type, status, nextRunAt, createdAt, [status+nextRunAt], [status+type]",
      executions: "id, taskId, status, startedAt, [taskId+startedAt]",
    })
  }

  // ========== Task Operations ==========

  /**
   * Create a new task
   */
  async createTask(task: ScheduledTask): Promise<void> {
    await this.tasks.add(serializeTask(task))
  }

  /**
   * Update an existing task
   */
  async updateTask(task: ScheduledTask): Promise<void> {
    await this.tasks.put(serializeTask(task))
  }

  /**
   * Delete a task and its executions
   */
  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.tasks.get(taskId)
    if (!task) return false

    await this.transaction("rw", [this.tasks, this.executions], async () => {
      await this.executions.where("taskId").equals(taskId).delete()
      await this.tasks.delete(taskId)
    })

    return true
  }

  /**
   * Get a task by ID
   */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    const dbTask = await this.tasks.get(taskId)
    return dbTask ? deserializeTask(dbTask) : null
  }

  /**
   * Get all tasks
   */
  async getAllTasks(): Promise<ScheduledTask[]> {
    const dbTasks = await this.tasks.toArray()
    return dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)
  }

  /**
   * Get tasks by status
   */
  async getTasksByStatus(status: ScheduledTaskStatus): Promise<ScheduledTask[]> {
    const dbTasks = await this.tasks.where("status").equals(status).toArray()
    return dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)
  }

  /**
   * Get tasks with filters
   */
  async getFilteredTasks(filter: TaskFilter): Promise<ScheduledTask[]> {
    let collection = this.tasks.toCollection()

    // Apply filters
    if (filter.statuses && filter.statuses.length > 0) {
      collection = this.tasks.where("status").anyOf(filter.statuses)
    }

    const dbTasks = await collection.toArray()
    let tasks = dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)

    // Filter by types
    if (filter.types && filter.types.length > 0) {
      tasks = tasks.filter((t) => filter.types!.includes(t.type))
    }

    // Filter by tags
    if (filter.tags && filter.tags.length > 0) {
      tasks = tasks.filter((t) => t.tags && filter.tags!.some((tag) => t.tags!.includes(tag)))
    }

    // Filter by search
    if (filter.search) {
      const searchLower = filter.search.toLowerCase()
      tasks = tasks.filter(
        (t) =>
          t.name.toLowerCase().includes(searchLower) ||
          t.description?.toLowerCase().includes(searchLower)
      )
    }

    return tasks
  }

  /**
   * Get active event-triggered tasks, optionally filtered by eventType
   */
  async getActiveEventTasks(eventType?: string): Promise<ScheduledTask[]> {
    // Use status index to narrow down, then filter by trigger type in memory
    // (trigger.type is inside serialized JSON, not a separate indexed column)
    const activeTasks = await this.tasks.where("status").equals("active").toArray()

    return activeTasks
      .map(safeDeserializeTask)
      .filter((t): t is ScheduledTask => t !== null)
      .filter(
        (t) => t.trigger.type === "event" && (!eventType || t.trigger.eventType === eventType)
      )
  }

  /**
   * Get upcoming tasks
   */
  async getUpcomingTasks(limit: number = 10): Promise<ScheduledTask[]> {
    const now = new Date().toISOString()
    const dbTasks = await this.tasks
      .where("status")
      .equals("active")
      .filter((t) => t.nextRunAt !== undefined && t.nextRunAt > now)
      .sortBy("nextRunAt")

    return dbTasks
      .slice(0, limit)
      .map(safeDeserializeTask)
      .filter((t): t is ScheduledTask => t !== null)
  }

  // ========== Execution Operations ==========

  /**
   * Create an execution record
   */
  async createExecution(execution: TaskExecution): Promise<void> {
    await this.executions.add(serializeExecution(execution))
  }

  /**
   * Update an execution record
   */
  async updateExecution(execution: TaskExecution): Promise<void> {
    await this.executions.put(serializeExecution(execution))
  }

  /**
   * Get executions for a task with efficient pagination
   * @param beforeStartedAt - cursor for pagination: only return executions started before this ISO string
   */
  async getTaskExecutions(
    taskId: string,
    limit: number = 50,
    beforeStartedAt?: string
  ): Promise<TaskExecution[]> {
    const collection = this.executions.where("[taskId+startedAt]").between(
      [taskId, Dexie.minKey],
      [taskId, beforeStartedAt || Dexie.maxKey],
      true,
      !beforeStartedAt // inclusive upper bound only when no cursor
    )

    const dbExecutions = await collection.reverse().limit(limit).toArray()

    return dbExecutions.map(safeDeserializeExecution).filter((e): e is TaskExecution => e !== null)
  }

  /**
   * Get recent executions across all tasks
   */
  async getRecentExecutions(limit: number = 50): Promise<TaskExecution[]> {
    const dbExecutions = await this.executions.orderBy("startedAt").reverse().limit(limit).toArray()

    return dbExecutions.map(safeDeserializeExecution).filter((e): e is TaskExecution => e !== null)
  }

  /**
   * Get execution by ID
   */
  async getExecution(executionId: string): Promise<TaskExecution | null> {
    const dbExecution = await this.executions.get(executionId)
    return dbExecution ? deserializeExecution(dbExecution) : null
  }

  /**
   * Delete old executions
   */
  async cleanupOldExecutions(maxAgeDays: number): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)
    const cutoffStr = cutoffDate.toISOString()

    // Use indexed startedAt for efficient range query
    const oldIds = await this.executions.where("startedAt").below(cutoffStr).primaryKeys()

    if (oldIds.length > 0) {
      await this.executions.bulkDelete(oldIds)
    }

    return oldIds.length
  }

  // ========== Statistics ==========

  /**
   * Get task statistics — uses indexed counts to avoid loading all records into memory
   */
  async getStatistics(): Promise<TaskStatistics> {
    const now = new Date().toISOString()

    // Use indexed count queries instead of loading full arrays
    const [
      totalTasks,
      activeTaskCount,
      pausedTaskCount,
      totalExecutions,
      successfulCount,
      failedCount,
    ] = await Promise.all([
      this.tasks.count(),
      this.tasks.where("status").equals("active").count(),
      this.tasks.where("status").equals("paused").count(),
      this.executions.count(),
      this.executions.where("status").equals("completed").count(),
      this.executions.where("status").equals("failed").count(),
    ])

    // Count upcoming tasks using compound index
    const upcomingCount = await this.tasks
      .where("status")
      .equals("active")
      .filter((t) => t.nextRunAt !== undefined && t.nextRunAt > now)
      .count()

    // Calculate average duration — only load durations, not full records
    let averageDuration = 0
    let durationCount = 0
    let durationSum = 0
    await this.executions
      .where("status")
      .equals("completed")
      .each((e) => {
        if (e.duration !== undefined) {
          durationSum += e.duration
          durationCount++
        }
      })
    if (durationCount > 0) {
      averageDuration = Math.round(durationSum / durationCount)
    }

    return {
      totalTasks,
      activeTasks: activeTaskCount,
      pausedTasks: pausedTaskCount,
      totalExecutions,
      successfulExecutions: successfulCount,
      failedExecutions: failedCount,
      averageDuration,
      upcomingExecutions: upcomingCount,
    }
  }

  /**
   * Clear all data (for testing/reset)
   */
  async clearAll(): Promise<void> {
    await this.transaction("rw", [this.tasks, this.executions], async () => {
      await this.tasks.clear()
      await this.executions.clear()
    })
  }
}

// ========== Serialization Helpers ==========

function serializeTask(task: ScheduledTask): DBScheduledTask {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    type: task.type,
    trigger: JSON.stringify({
      ...task.trigger,
      runAt: task.trigger.runAt?.toISOString(),
    }),
    payload: JSON.stringify(task.payload),
    config: JSON.stringify(task.config),
    notification: JSON.stringify(task.notification),
    status: task.status,
    tags: task.tags ? JSON.stringify(task.tags) : undefined,
    lastRunAt: task.lastRunAt?.toISOString(),
    nextRunAt: task.nextRunAt?.toISOString(),
    runCount: task.runCount,
    successCount: task.successCount,
    failureCount: task.failureCount,
    lastError: task.lastError,
    lastTerminalReason: task.lastTerminalReason,
    lastTerminalAt: task.lastTerminalAt?.toISOString(),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

function deserializeTask(dbTask: DBScheduledTask): ScheduledTask {
  const trigger = JSON.parse(dbTask.trigger)
  return {
    id: dbTask.id,
    name: dbTask.name,
    description: dbTask.description,
    type: dbTask.type as ScheduledTask["type"],
    trigger: {
      ...trigger,
      runAt: trigger.runAt ? new Date(trigger.runAt) : undefined,
    },
    payload: JSON.parse(dbTask.payload),
    config: JSON.parse(dbTask.config),
    notification: JSON.parse(dbTask.notification),
    status: dbTask.status as ScheduledTask["status"],
    tags: dbTask.tags ? JSON.parse(dbTask.tags) : undefined,
    lastRunAt: dbTask.lastRunAt ? new Date(dbTask.lastRunAt) : undefined,
    nextRunAt: dbTask.nextRunAt ? new Date(dbTask.nextRunAt) : undefined,
    runCount: dbTask.runCount,
    successCount: dbTask.successCount,
    failureCount: dbTask.failureCount,
    lastError: dbTask.lastError,
    lastTerminalReason: dbTask.lastTerminalReason,
    lastTerminalAt: dbTask.lastTerminalAt ? new Date(dbTask.lastTerminalAt) : undefined,
    createdAt: new Date(dbTask.createdAt),
    updatedAt: new Date(dbTask.updatedAt),
  }
}

function safeDeserializeTask(dbTask: DBScheduledTask): ScheduledTask | null {
  try {
    return deserializeTask(dbTask)
  } catch (error) {
    log.warn(
      `Failed to deserialize task ${dbTask.id}: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

function serializeExecution(execution: TaskExecution): DBTaskExecution {
  return {
    id: execution.id,
    taskId: execution.taskId,
    taskName: execution.taskName,
    taskType: execution.taskType,
    status: execution.status,
    input: execution.input ? JSON.stringify(execution.input) : undefined,
    output: execution.output ? JSON.stringify(execution.output) : undefined,
    error: execution.error,
    retryAttempt: execution.retryAttempt,
    duration: execution.duration,
    scheduledFor: execution.scheduledFor?.toISOString(),
    triggerSource: execution.triggerSource,
    terminalReason: execution.terminalReason,
    retryScheduledAt: execution.retryScheduledAt?.toISOString(),
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt?.toISOString(),
    logs: JSON.stringify(
      execution.logs.map((log) => ({
        ...log,
        timestamp: log.timestamp.toISOString(),
      }))
    ),
  }
}

function deserializeExecution(dbExecution: DBTaskExecution): TaskExecution {
  const logs = JSON.parse(dbExecution.logs)
  return {
    id: dbExecution.id,
    taskId: dbExecution.taskId,
    taskName: dbExecution.taskName,
    taskType: dbExecution.taskType as TaskExecution["taskType"],
    status: dbExecution.status as TaskExecution["status"],
    input: dbExecution.input ? JSON.parse(dbExecution.input) : undefined,
    output: dbExecution.output ? JSON.parse(dbExecution.output) : undefined,
    error: dbExecution.error,
    retryAttempt: dbExecution.retryAttempt,
    duration: dbExecution.duration,
    scheduledFor: dbExecution.scheduledFor ? new Date(dbExecution.scheduledFor) : undefined,
    triggerSource: dbExecution.triggerSource as TaskExecution["triggerSource"],
    terminalReason: dbExecution.terminalReason,
    retryScheduledAt: dbExecution.retryScheduledAt
      ? new Date(dbExecution.retryScheduledAt)
      : undefined,
    startedAt: new Date(dbExecution.startedAt),
    completedAt: dbExecution.completedAt ? new Date(dbExecution.completedAt) : undefined,
    logs: logs.map((entry: Record<string, unknown>) => ({
      ...entry,
      timestamp: new Date(entry.timestamp as string),
    })),
  }
}

function safeDeserializeExecution(dbExecution: DBTaskExecution): TaskExecution | null {
  try {
    return deserializeExecution(dbExecution)
  } catch (error) {
    log.warn(
      `Failed to deserialize execution ${dbExecution.id}: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

// Export singleton instance
export const schedulerDb = new SchedulerDatabase()

export { SchedulerDatabase }
