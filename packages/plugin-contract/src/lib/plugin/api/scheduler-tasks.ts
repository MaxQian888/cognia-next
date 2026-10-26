/**
 * The plugin contract's share of `lib/plugin/api/scheduler-tasks.ts`, which re-exports these.
 */
import type { CancelExecutionOutcome } from "../../scheduler/task-scheduler"
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskType,
  SchedulerPermissionPolicy,
  TaskExecution,
  TaskExecutionTriggerSource,
  UpdateScheduledTaskInput,
} from "../../../types/scheduler/index"

/**
 * Who a write is made as. A plugin acting on its own initiative is `plugin`;
 * a plugin tool an agent called is `agent`, with the agent's chat session, so
 * the user's agent policy (`agentToolsEnabled`, `agentAutoCreate`, the agent
 * quota) applies to it.
 */
export type PluginSchedulerActor = { kind: "plugin" } | { kind: "agent"; sessionId?: string }

export interface PluginSchedulerWriteOptions {
  /** Defaults to `{ kind: "plugin" }`. */
  actor?: PluginSchedulerActor
}

export interface PluginSchedulerRunOptions extends PluginSchedulerWriteOptions {
  /** Defaults to `"run-now"`, so history tells a manual run from a scheduled one. */
  triggerSource?: TaskExecutionTriggerSource
}

export interface PluginSchedulerExecutionPage {
  /** Rows per page, 1–200. Default 50. */
  limit?: number
  /** Only runs that started strictly before this instant (the cursor of the previous page). */
  before?: Date | string
}

/** One projected future run of one task. */
export interface PluginUpcomingRun {
  taskId: string
  taskName: string
  taskType: ScheduledTaskType
  at: Date
}

export interface PluginUserSchedulerAPI {
  getPolicy(): Promise<SchedulerPermissionPolicy>
  listTasks(): Promise<ScheduledTask[]>
  getTask(taskId: string): Promise<ScheduledTask | null>
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask | null>
  updateTask(
    taskId: string,
    input: UpdateScheduledTaskInput,
    options?: PluginSchedulerWriteOptions
  ): Promise<ScheduledTask | null>
  deleteTask(taskId: string, options?: PluginSchedulerWriteOptions): Promise<boolean>
  pauseTask(taskId: string, options?: PluginSchedulerWriteOptions): Promise<boolean>
  resumeTask(taskId: string, options?: PluginSchedulerWriteOptions): Promise<boolean>
  runTaskNow(taskId: string, options?: PluginSchedulerRunOptions): Promise<TaskExecution | null>
  listExecutions(taskId: string, page?: PluginSchedulerExecutionPage): Promise<TaskExecution[]>
  getExecution(executionId: string): Promise<TaskExecution | null>
  cancelExecution(
    executionId: string,
    options?: PluginSchedulerWriteOptions
  ): Promise<CancelExecutionOutcome>
  getUpcoming(taskId?: string, count?: number): Promise<PluginUpcomingRun[]>
}
