import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  TaskExecution,
  TaskExecutionTriggerSource,
  TaskFilter,
  TaskStatistics,
  UpdateScheduledTaskInput,
} from "@/types/scheduler"
import { transport } from "@/lib/tauri"
import { getEffectiveSchedulerHostTarget } from "./scheduler-host-target"
import { schedulerDb } from "./scheduler-db"
import { resolveTaskWorkspace } from "./task-workspace-binding"
import { getTaskScheduler } from "./task-scheduler"

export interface SchedulerDataSource {
  readonly host: "local" | "remote"
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask>
  updateTask(
    taskId: string,
    input: UpdateScheduledTaskInput,
    taskType?: string
  ): Promise<ScheduledTask | null>
  deleteTask(taskId: string, taskType?: string): Promise<boolean>
  getTask(taskId: string): Promise<ScheduledTask | null>
  pauseTask(taskId: string, taskType?: string): Promise<boolean>
  resumeTask(taskId: string, taskType?: string): Promise<boolean>
  runTaskNow(
    taskId: string,
    options?: { triggerSource?: TaskExecutionTriggerSource; taskType?: string }
  ): Promise<TaskExecution | null>
  backfillTask(taskId: string, range: { start: Date; end: Date }): Promise<TaskExecution[]>
  listTasks(filter?: TaskFilter): Promise<ScheduledTask[]>
  getTaskExecutions(
    taskId: string,
    limit?: number,
    beforeStartedAt?: string,
    taskType?: string
  ): Promise<TaskExecution[]>
  getStatistics(): Promise<TaskStatistics>
  getRecentExecutions(limit?: number): Promise<TaskExecution[]>
  getUpcomingTasks(limit?: number): Promise<ScheduledTask[]>
  exportTasks(taskIds?: string[]): Promise<{
    version: number
    exportedAt: string
    tasks: ScheduledTask[]
  }>
  importTasks(
    data: { version: number; tasks: ScheduledTask[] },
    mode?: "merge" | "replace"
  ): Promise<{ imported: number; skipped: number; errors: string[] }>
  cleanupOldExecutions(maxAgeDays: number): Promise<number>
}

class LocalSchedulerDataSource implements SchedulerDataSource {
  readonly host = "local" as const

  async createTask(input: CreateScheduledTaskInput) {
    // The UI boundary, and the only place "the workspace on screen" is a
    // legitimate fallback. `createTask` itself still resolves the creating
    // conversation's workspace for the callers that bypass this one (the
    // workflow node, an interval `/loop`) — see `resolveTaskWorkspace`.
    return getTaskScheduler().createTask({
      ...input,
      projectId: await resolveTaskWorkspace(input),
      // Said even when the answer is `undefined`: an unattributed row IS the
      // resolved answer here, and without this the scheduler would repeat the
      // same main-database lookup under a second timeout budget.
      workspaceResolved: true,
    })
  }

  updateTask(taskId: string, input: UpdateScheduledTaskInput) {
    return getTaskScheduler().updateTask(taskId, input)
  }

  deleteTask(taskId: string) {
    return getTaskScheduler().deleteTask(taskId)
  }

  getTask(taskId: string) {
    return getTaskScheduler().getTask(taskId)
  }

  pauseTask(taskId: string) {
    return getTaskScheduler().pauseTask(taskId)
  }

  resumeTask(taskId: string) {
    return getTaskScheduler().resumeTask(taskId)
  }

  runTaskNow(taskId: string, options?: { triggerSource?: TaskExecutionTriggerSource }) {
    return getTaskScheduler().runTaskNow(taskId, options)
  }

  backfillTask(taskId: string, range: { start: Date; end: Date }) {
    return getTaskScheduler().backfillTask(taskId, range)
  }

  listTasks(filter?: TaskFilter) {
    return filter && Object.keys(filter).length > 0
      ? schedulerDb.getFilteredTasks(filter)
      : schedulerDb.getAllTasks()
  }

  getTaskExecutions(taskId: string, limit = 50, beforeStartedAt?: string) {
    return schedulerDb.getTaskExecutions(taskId, limit, beforeStartedAt)
  }

  getStatistics() {
    return schedulerDb.getStatistics()
  }

  getRecentExecutions(limit = 50) {
    return schedulerDb.getRecentExecutions(limit)
  }

  getUpcomingTasks(limit = 10) {
    return schedulerDb.getUpcomingTasks(limit)
  }

  exportTasks(taskIds?: string[]) {
    return getTaskScheduler().exportTasks(taskIds)
  }

  importTasks(
    data: { version: number; tasks: ScheduledTask[] },
    mode: "merge" | "replace" = "merge"
  ) {
    return getTaskScheduler().importTasks(data, mode)
  }

  cleanupOldExecutions(maxAgeDays: number) {
    return schedulerDb.cleanupOldExecutions(maxAgeDays)
  }
}

type TaskWire = Omit<
  ScheduledTask,
  "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt" | "lastTerminalAt" | "endAt"
> & {
  createdAt: string | Date
  updatedAt: string | Date
  lastRunAt?: string | Date
  nextRunAt?: string | Date
  lastTerminalAt?: string | Date
  endAt?: string | Date
}

type ExecutionWire = Omit<
  TaskExecution,
  "startedAt" | "completedAt" | "scheduledFor" | "retryScheduledAt" | "logs"
> & {
  startedAt: string | Date
  completedAt?: string | Date
  scheduledFor?: string | Date
  retryScheduledAt?: string | Date
  logs: Array<Omit<TaskExecution["logs"][number], "timestamp"> & { timestamp: string | Date }>
}

function date(value: string | Date | undefined): Date | undefined {
  return value === undefined ? undefined : value instanceof Date ? value : new Date(value)
}

function hydrateTask(task: TaskWire): ScheduledTask {
  const trigger = task.trigger as ScheduledTask["trigger"] & { runAt?: string | Date }
  return {
    ...task,
    trigger: {
      ...trigger,
      runAt: date(trigger.runAt),
    } as ScheduledTask["trigger"],
    createdAt: date(task.createdAt)!,
    updatedAt: date(task.updatedAt)!,
    lastRunAt: date(task.lastRunAt),
    nextRunAt: date(task.nextRunAt),
    lastTerminalAt: date(task.lastTerminalAt),
    endAt: date(task.endAt),
  } as ScheduledTask
}

function hydrateExecution(execution: ExecutionWire): TaskExecution {
  return {
    ...execution,
    startedAt: date(execution.startedAt)!,
    completedAt: date(execution.completedAt),
    scheduledFor: date(execution.scheduledFor),
    retryScheduledAt: date(execution.retryScheduledAt),
    logs: execution.logs.map((entry) => ({
      ...entry,
      timestamp: date(entry.timestamp)!,
    })),
  } as TaskExecution
}

class RemoteSchedulerDataSource implements SchedulerDataSource {
  readonly host = "remote" as const

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    const task = await transport.call<TaskWire>("scheduled_task_create", {
      input,
      taskType: input.type,
    })
    return hydrateTask(task)
  }

  async updateTask(
    taskId: string,
    input: UpdateScheduledTaskInput,
    taskType?: string
  ): Promise<ScheduledTask | null> {
    const task = await transport.call<TaskWire | null>("scheduled_task_update", {
      taskId,
      input,
      taskType,
    })
    return task ? hydrateTask(task) : null
  }

  deleteTask(taskId: string, taskType?: string): Promise<boolean> {
    return transport.call("scheduled_task_delete", { taskId, taskType })
  }

  async getTask(taskId: string): Promise<ScheduledTask | null> {
    const task = await transport.call<TaskWire | null>("scheduled_task_get", { taskId })
    return task ? hydrateTask(task) : null
  }

  pauseTask(taskId: string, taskType?: string): Promise<boolean> {
    return transport.call("scheduled_task_pause", { taskId, taskType })
  }

  resumeTask(taskId: string, taskType?: string): Promise<boolean> {
    return transport.call("scheduled_task_resume", { taskId, taskType })
  }

  async runTaskNow(
    taskId: string,
    options?: { triggerSource?: TaskExecutionTriggerSource; taskType?: string }
  ): Promise<TaskExecution | null> {
    const execution = await transport.call<ExecutionWire | null>("scheduled_task_run_now", {
      taskId,
      triggerSource: options?.triggerSource,
      taskType: options?.taskType,
    })
    return execution ? hydrateExecution(execution) : null
  }

  async backfillTask(taskId: string, range: { start: Date; end: Date }): Promise<TaskExecution[]> {
    const rows = await transport.call<ExecutionWire[]>("scheduled_task_backfill", {
      taskId,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    })
    return rows.map(hydrateExecution)
  }

  async listTasks(filter?: TaskFilter): Promise<ScheduledTask[]> {
    const rows = await transport.call<TaskWire[]>("scheduled_task_list", { filter })
    return rows.map(hydrateTask)
  }

  async getTaskExecutions(
    taskId: string,
    limit = 50,
    beforeStartedAt?: string,
    taskType?: string
  ): Promise<TaskExecution[]> {
    const rows = await transport.call<ExecutionWire[]>("scheduled_task_runs", {
      taskId,
      limit,
      beforeStartedAt,
      taskType,
    })
    return rows.map(hydrateExecution)
  }

  getStatistics(): Promise<TaskStatistics> {
    return transport.call("scheduled_task_statistics")
  }

  async getRecentExecutions(limit = 50): Promise<TaskExecution[]> {
    const rows = await transport.call<ExecutionWire[]>("scheduled_task_runs", { limit })
    return rows.map(hydrateExecution)
  }

  async getUpcomingTasks(limit = 10): Promise<ScheduledTask[]> {
    const rows = await transport.call<TaskWire[]>("scheduled_task_upcoming", { limit })
    return rows.map(hydrateTask)
  }

  async exportTasks(taskIds?: string[]) {
    const value = await transport.call<{
      version: number
      exportedAt: string
      tasks: TaskWire[]
    }>("scheduled_task_export", { taskIds })
    return { ...value, tasks: value.tasks.map(hydrateTask) }
  }

  importTasks(
    data: { version: number; tasks: ScheduledTask[] },
    mode: "merge" | "replace" = "merge"
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    return transport.call("scheduled_task_import", { data, mode })
  }

  cleanupOldExecutions(maxAgeDays: number): Promise<number> {
    return transport.call("scheduled_task_cleanup", { maxAgeDays })
  }
}

const localDataSource = new LocalSchedulerDataSource()
const remoteDataSource = new RemoteSchedulerDataSource()

/**
 * The data source for the schedule the UI currently manages: the paired /
 * remote host's (through the `scheduled_task_*` RPCs) or this device's own
 * (`TaskScheduler`) — see `scheduler-host-target.ts` for how the target is
 * chosen. `host` on the returned source tells callers which one they got.
 */
export function getSchedulerDataSource(): SchedulerDataSource {
  return getEffectiveSchedulerHostTarget() === "paired" ? remoteDataSource : localDataSource
}
