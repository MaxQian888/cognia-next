/** Portable scheduled-task authoring contracts. Runtime operations live on context APIs. */

import type { PluginScheduledTaskDef } from "@/types/plugin"
import type { TaskTrigger } from "@/types/scheduler"

export { defineScheduledTask } from "../define/define-scheduled-task"
export type { PluginScheduledTaskDef } from "@/types/plugin"
export type {
  CreatePluginTaskInput,
  PluginScheduledTask,
  PluginSchedulerAPI,
  PluginTaskContext,
  PluginTaskExecution,
  PluginTaskExecutionEvent,
  PluginTaskExecutionOptions,
  PluginTaskExecutionPhase,
  PluginTaskExecutionStatus,
  PluginTaskFilter,
  PluginTaskHandler,
  PluginTaskOverlapPolicy,
  PluginTaskResult,
  PluginTaskRetryConfig,
  PluginTaskStatistics,
  PluginTaskStatus,
  PluginTaskTrigger,
  UpdatePluginTaskInput,
} from "@/types/plugin/plugin-scheduler"
export type {
  PluginSchedulerActor,
  PluginSchedulerExecutionPage,
  PluginSchedulerRunOptions,
  PluginSchedulerWriteOptions,
  PluginUpcomingRun,
  PluginUserSchedulerAPI,
} from "@/lib/plugin/api/scheduler-tasks"
export type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskStatus,
  ScheduledTaskType,
  SchedulerPermissionPolicy,
  TaskExecution,
  TaskExecutionStatus,
  TaskExecutionTriggerSource,
  TaskTrigger,
  TaskTriggerType,
  UpdateScheduledTaskInput,
} from "@/types/scheduler"
export { DEFAULT_PERMISSION_POLICY } from "@/types/scheduler"

/** Project a declarative plugin trigger into the host scheduler vocabulary. */
export function toTaskTrigger(def: PluginScheduledTaskDef): TaskTrigger {
  const trigger = def.trigger
  switch (trigger.type) {
    case "cron":
      return {
        type: "cron",
        cronExpression: trigger.expression,
        timezone: trigger.timezone,
      }
    case "interval":
      return { type: "interval", intervalMs: Math.max(0, trigger.seconds) * 1000 }
    case "once":
      return { type: "once", runAt: new Date(trigger.runAt) }
    case "event":
      return {
        type: "event",
        eventType: trigger.eventType,
        eventSource: trigger.eventSource,
      }
  }
}
