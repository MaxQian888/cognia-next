import type { ScheduledTaskStatus, ScheduledTaskType, TaskFilter } from "@/types/scheduler"
import { registerNodeExecutor } from "../registry"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import {
  buildSchedulerCreateInput,
  buildSchedulerUpdateInput,
  clampSchedulerExecutionLimit,
  clampSchedulerTaskLimit,
  nonRetryable,
  normalizeOptionalString,
  normalizeSchedulerDate,
  normalizeSchedulerStatuses,
  normalizeSchedulerTypes,
  normalizeStringList,
  parseSchedulerImportData,
  parseSchedulerObjectParam,
  readRequiredSchedulerString,
  requireSchedulerExecutionId,
  requireSchedulerTaskId,
  toWorkflowScheduledTask,
  toWorkflowTaskExecution,
} from "../shared/executor-support"

// ── action.scheduler.task.* ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.scheduler.task.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const task = await getTaskScheduler().createTask(buildSchedulerCreateInput(ctx.params))
    return { output: { taskId: task.id, task: toWorkflowScheduledTask(task) } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.get")
    const task = await getTaskScheduler().getTask(taskId)
    return { output: { taskId, task: toWorkflowScheduledTask(task) } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      statuses?: ScheduledTaskStatus[]
      statusesRaw?: string
      types?: ScheduledTaskType[]
      typesRaw?: string
      tags?: string[]
      tagsRaw?: string
      search?: string
      limit?: number
    }
    const limit = clampSchedulerTaskLimit(params.limit)
    const filter: TaskFilter = {
      statuses: normalizeSchedulerStatuses(params.statuses, params.statusesRaw),
      types: normalizeSchedulerTypes(params.types, params.typesRaw),
      tags: normalizeStringList(params.tags, params.tagsRaw),
      search: normalizeOptionalString(params.search),
    }
    const hasFilter = Boolean(
      filter.statuses?.length || filter.types?.length || filter.tags?.length || filter.search
    )
    const tasks = hasFilter
      ? await schedulerDb.getFilteredTasks(filter)
      : await schedulerDb.getAllTasks()
    const safeTasks = tasks.slice(0, limit)
    return {
      output: {
        count: safeTasks.length,
        tasks: safeTasks.map(toWorkflowScheduledTask),
        task: toWorkflowScheduledTask(safeTasks[0]),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.update")
    const patch = buildSchedulerUpdateInput(ctx.params)
    if (Object.keys(patch).length === 0) {
      throw nonRetryable("action.scheduler.task.update requires at least one patch field")
    }
    const task = await getTaskScheduler().updateTask(taskId, patch)
    return { output: { taskId, changed: task !== null, task: toWorkflowScheduledTask(task) } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.pause",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.pause")
    const changed = await getTaskScheduler().pauseTask(taskId)
    return { output: { taskId, changed } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.resume",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.resume")
    const changed = await getTaskScheduler().resumeTask(taskId)
    return { output: { taskId, changed } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.delete")
    const deleted = await getTaskScheduler().deleteTask(taskId)
    return { output: { taskId, deleted } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.runNow",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.runNow")
    const execution = await getTaskScheduler().runTaskNow(taskId, { triggerSource: "run-now" })
    return {
      output: {
        taskId,
        ran: execution !== null,
        executionId: execution?.id ?? null,
        execution: toWorkflowTaskExecution(execution),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.executions",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.executions")
    const executions = await getTaskScheduler().getTaskExecutions(
      taskId,
      clampSchedulerExecutionLimit(params.limit)
    )
    const safeExecutions = executions.map(toWorkflowTaskExecution)
    return {
      output: {
        taskId,
        count: safeExecutions.length,
        executions: safeExecutions,
        execution: safeExecutions[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.backfill",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { start?: string; end?: string }
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.backfill")
    const start = normalizeSchedulerDate(params.start, "scheduler backfill start")
    const end = normalizeSchedulerDate(params.end, "scheduler backfill end")
    if (!start) throw nonRetryable("action.scheduler.task.backfill requires 'start'")
    if (!end) throw nonRetryable("action.scheduler.task.backfill requires 'end'")
    const executions = await getTaskScheduler().backfillTask(taskId, { start, end })
    const safeExecutions = executions.map(toWorkflowTaskExecution)
    return {
      output: {
        taskId,
        count: safeExecutions.length,
        executions: safeExecutions,
        execution: safeExecutions[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.export",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { taskIds?: string[]; taskIdsRaw?: string }
    const taskIds = normalizeStringList(params.taskIds, params.taskIdsRaw)
    const data = await getTaskScheduler().exportTasks(taskIds)
    const tasks = data.tasks.map(toWorkflowScheduledTask)
    return {
      output: {
        version: data.version,
        exportedAt: data.exportedAt,
        count: tasks.length,
        data,
        tasks,
        task: tasks[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.import",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      data?: unknown
      dataJson?: string
      mode?: "merge" | "replace"
    }
    const data = parseSchedulerImportData(params.data, params.dataJson)
    const mode = params.mode === "replace" ? "replace" : "merge"
    const result = await getTaskScheduler().importTasks(data, mode)
    return { output: result }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.status",
  typeVersion: 1,
  execute: async () => ({ output: getTaskScheduler().getStatus() }),
})

registerNodeExecutor({
  kind: "action.scheduler.statistics",
  typeVersion: 1,
  execute: async () => ({ output: await schedulerDb.getStatistics() }),
})

registerNodeExecutor({
  kind: "action.scheduler.upcoming",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const tasks = await schedulerDb.getUpcomingTasks(clampSchedulerTaskLimit(params.limit))
    const safeTasks = tasks.map(toWorkflowScheduledTask)
    return {
      output: {
        count: safeTasks.length,
        tasks: safeTasks,
        task: safeTasks[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.executions.recent",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const executions = await schedulerDb.getRecentExecutions(
      clampSchedulerExecutionLimit(params.limit)
    )
    const safeExecutions = executions.map(toWorkflowTaskExecution)
    return {
      output: {
        count: safeExecutions.length,
        executions: safeExecutions,
        execution: safeExecutions[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.execution.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const executionId = requireSchedulerExecutionId(ctx, "action.scheduler.execution.get")
    const execution = await schedulerDb.getExecution(executionId)
    return {
      output: {
        executionId,
        execution: toWorkflowTaskExecution(execution),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.event.trigger",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      eventType?: string
      eventSource?: string
      payload?: Record<string, unknown>
      payloadJson?: string
    }
    const eventType = readRequiredSchedulerString(
      params.eventType,
      "scheduler event trigger eventType"
    )
    const eventSource = normalizeOptionalString(params.eventSource)
    const payload = parseSchedulerObjectParam(
      params.payload,
      params.payloadJson,
      "scheduler event payloadJson"
    )
    await getTaskScheduler().triggerEventTask(eventType, eventSource, payload)
    return {
      output: {
        eventType,
        eventSource,
        triggered: true,
        payload: payload ?? {},
      },
    }
  },
})
