/**
 * Plugin SDK - `scheduled-task` capability surface.
 *
 * Re-exports the declarative authoring helper, manifest bridge, task
 * definition registry, and plugin task handler registry.
 */

export { defineScheduledTask } from "../define/define-scheduled-task"

export {
  registerScheduledTasksForPlugin,
  toTaskTrigger,
  unregisterScheduledTasksForPlugin,
} from "@/lib/plugin/bridge/scheduled-task-bridge"

export type {
  ScheduledTaskBridgeOptions,
  ScheduledTaskBridgeResult,
  ScheduledTaskSchedulerPort,
} from "@/lib/plugin/bridge/scheduled-task-bridge"

export {
  listScheduledTaskDefs,
  registerScheduledTaskDefsForPlugin,
  subscribeScheduledTaskDefs,
  unregisterScheduledTaskDefsByPlugin,
} from "@/lib/plugin/scheduler/scheduled-task-registry"

export type { RegisteredScheduledTask } from "@/lib/plugin/scheduler/scheduled-task-registry"

export {
  clearPluginTaskHandlers,
  getPluginTaskHandler,
  getPluginTaskHandlerNames,
  hasPluginTaskHandler,
  registerPluginTaskHandler,
  unregisterPluginTaskHandler,
} from "@/lib/plugin/scheduler/scheduler-plugin-executor"

export type { PluginScheduledTaskDef } from "@/types/plugin"
export type {
  PluginSchedulerAPI,
  PluginTaskContext,
  PluginTaskHandler,
  PluginTaskResult,
  PluginTaskTrigger,
} from "@/types/plugin/plugin-scheduler"

/**
 * The scheduler domain vocabulary. A plugin that creates or inspects tasks
 * types them against the host's own row shapes rather than a private copy.
 */
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
} from "@/types/scheduler"

export { DEFAULT_PERMISSION_POLICY } from "@/types/scheduler"

/**
 * The USER's scheduled tasks — the `/scheduler` list — as opposed to the
 * plugin-owned tasks `ctx.scheduler` manages. An agent tool that schedules
 * work on the user's behalf lives here, and MUST consult
 * `getSchedulerPermissionPolicy()` before creating anything: the policy is the
 * user's standing answer to "may something other than me put work on my
 * schedule?", and the store does not enforce it on write.
 */
export {
  createUserScheduledTask,
  deleteUserScheduledTask,
  getSchedulerPermissionPolicy,
  listUserScheduledTasks,
  runUserScheduledTaskNow,
} from "@/lib/plugin/api/scheduler-tasks"
