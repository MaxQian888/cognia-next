import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  TaskExecutionTriggerSource,
  TaskFilter,
  UpdateScheduledTaskInput,
} from "@/types/scheduler"
import { schedulerDb } from "./scheduler-db"
import { getTaskScheduler } from "./task-scheduler"

const COMMANDS = new Set([
  "scheduled_task_list",
  "scheduled_task_get",
  "scheduled_task_runs",
  "scheduled_task_create",
  "scheduled_task_update",
  "scheduled_task_delete",
  "scheduled_task_pause",
  "scheduled_task_resume",
  "scheduled_task_run_now",
  "scheduled_task_backfill",
  "scheduled_task_statistics",
  "scheduled_task_upcoming",
  "scheduled_task_export",
  "scheduled_task_import",
  "scheduled_task_cleanup",
  "scheduled_task_emit_event",
])

export function isScheduledTaskRpc(command: string): boolean {
  return COMMANDS.has(command)
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`)
  }
  return value
}

function dateField(payload: Record<string, unknown>, key: string): Date {
  const value = stringField(payload, key)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`${key} must be an ISO date`)
  return parsed
}

function reviveCreateInput(value: unknown): CreateScheduledTaskInput {
  if (!value || typeof value !== "object") throw new Error("input is required")
  const input = value as CreateScheduledTaskInput
  return {
    ...input,
    trigger: {
      ...input.trigger,
      ...("runAt" in input.trigger && input.trigger.runAt
        ? { runAt: new Date(input.trigger.runAt) }
        : {}),
    },
    endAt: input.endAt ? new Date(input.endAt) : undefined,
  }
}

function reviveUpdateInput(value: unknown): UpdateScheduledTaskInput {
  if (!value || typeof value !== "object") throw new Error("input is required")
  const input = value as UpdateScheduledTaskInput
  return {
    ...input,
    trigger: input.trigger
      ? {
          ...input.trigger,
          ...("runAt" in input.trigger && input.trigger.runAt
            ? { runAt: new Date(input.trigger.runAt) }
            : {}),
        }
      : undefined,
    endAt: input.endAt ? new Date(input.endAt) : input.endAt,
  }
}

function reviveImportedTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    trigger: {
      ...task.trigger,
      ...("runAt" in task.trigger && task.trigger.runAt
        ? { runAt: new Date(task.trigger.runAt) }
        : {}),
    },
    endAt: task.endAt ? new Date(task.endAt) : undefined,
    lastRunAt: task.lastRunAt ? new Date(task.lastRunAt) : undefined,
    nextRunAt: task.nextRunAt ? new Date(task.nextRunAt) : undefined,
    lastTerminalAt: task.lastTerminalAt ? new Date(task.lastTerminalAt) : undefined,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  }
}

export async function dispatchScheduledTaskRpc(
  command: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const scheduler = getTaskScheduler()
  switch (command) {
    case "scheduled_task_list": {
      const filter = payload.filter as TaskFilter | undefined
      return filter && Object.keys(filter).length > 0
        ? schedulerDb.getFilteredTasks(filter)
        : schedulerDb.getAllTasks()
    }
    case "scheduled_task_get":
      return scheduler.getTask(stringField(payload, "taskId"))
    case "scheduled_task_runs": {
      const limit =
        typeof payload.limit === "number" ? Math.min(Math.max(payload.limit, 1), 200) : 50
      if (typeof payload.taskId === "string") {
        return schedulerDb.getTaskExecutions(
          payload.taskId,
          limit,
          typeof payload.beforeStartedAt === "string" ? payload.beforeStartedAt : undefined
        )
      }
      return schedulerDb.getRecentExecutions(limit)
    }
    case "scheduled_task_create":
      return scheduler.createTask(reviveCreateInput(payload.input))
    case "scheduled_task_update":
      return scheduler.updateTask(stringField(payload, "taskId"), reviveUpdateInput(payload.input))
    case "scheduled_task_delete":
      return scheduler.deleteTask(stringField(payload, "taskId"))
    case "scheduled_task_pause":
      return scheduler.pauseTask(stringField(payload, "taskId"))
    case "scheduled_task_resume":
      return scheduler.resumeTask(stringField(payload, "taskId"))
    case "scheduled_task_run_now":
      return scheduler.runTaskNow(stringField(payload, "taskId"), {
        triggerSource:
          typeof payload.triggerSource === "string"
            ? (payload.triggerSource as TaskExecutionTriggerSource)
            : "run-now",
      })
    case "scheduled_task_backfill":
      return scheduler.backfillTask(stringField(payload, "taskId"), {
        start: dateField(payload, "start"),
        end: dateField(payload, "end"),
      })
    case "scheduled_task_statistics":
      return schedulerDb.getStatistics()
    case "scheduled_task_upcoming":
      return schedulerDb.getUpcomingTasks(
        typeof payload.limit === "number" ? Math.min(Math.max(payload.limit, 1), 100) : 10
      )
    case "scheduled_task_export":
      return scheduler.exportTasks(
        Array.isArray(payload.taskIds)
          ? payload.taskIds.filter((id): id is string => typeof id === "string")
          : undefined
      )
    case "scheduled_task_import": {
      if (!payload.data || typeof payload.data !== "object") throw new Error("data is required")
      const data = payload.data as { version: number; tasks: ScheduledTask[] }
      return scheduler.importTasks(
        { ...data, tasks: data.tasks.map(reviveImportedTask) },
        payload.mode === "replace" ? "replace" : "merge"
      )
    }
    case "scheduled_task_cleanup":
      return schedulerDb.cleanupOldExecutions(
        typeof payload.maxAgeDays === "number" ? Math.max(payload.maxAgeDays, 1) : 30
      )
    case "scheduled_task_emit_event":
      return scheduler.triggerEventTask(
        stringField(payload, "eventType"),
        typeof payload.eventSource === "string" ? payload.eventSource : undefined,
        payload.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : undefined
      )
    default:
      throw new Error(`unsupported scheduled task command: ${command}`)
  }
}
