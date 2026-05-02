/**
 * Plugin Scheduler Types
 *
 * Type definitions for the plugin scheduler API
 */

// =============================================================================
// Task Trigger Types
// =============================================================================

export interface CronTrigger {
  type: "cron"
  expression: string
  timezone?: string
}

export interface IntervalTrigger {
  type: "interval"
  seconds: number
  startImmediately?: boolean
}

export interface OnceTrigger {
  type: "once"
  runAt: Date | string
}

export interface EventTrigger {
  type: "event"
  eventType: string
  eventSource?: string
}

export type PluginTaskTrigger = CronTrigger | IntervalTrigger | OnceTrigger | EventTrigger

// =============================================================================
// Task Status & Result Types
// =============================================================================

export type PluginTaskStatus = "active" | "paused" | "disabled" | "completed" | "error"

export type PluginTaskExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"

export interface PluginTaskResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
  metrics?: {
    duration?: number
    itemsProcessed?: number
    [key: string]: unknown
  }
}

// =============================================================================
// Task Context
// =============================================================================

export interface PluginTaskContext {
  taskId: string
  executionId: string
  pluginId: string
  taskName: string
  scheduledAt: Date
  startedAt: Date
  attemptNumber: number
  signal: AbortSignal
  reportProgress: (progress: number, message?: string) => void
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>
  ) => void
}

// =============================================================================
// Task Handler
// =============================================================================

export type PluginTaskHandler = (
  args: Record<string, unknown>,
  context: PluginTaskContext
) => Promise<PluginTaskResult>

// =============================================================================
// Scheduled Task Definition
// =============================================================================

export interface PluginScheduledTask {
  id: string
  pluginId: string
  name: string
  description?: string
  trigger: PluginTaskTrigger
  handler: string
  handlerArgs?: Record<string, unknown>
  status: PluginTaskStatus
  lastRunAt?: Date
  nextRunAt?: Date
  runCount: number
  lastResult?: PluginTaskResult
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  retry?: {
    maxAttempts: number
    delaySeconds: number
    backoffMultiplier?: number
  }
  timeout?: number
  tags?: string[]
}

export interface PluginTaskExecution {
  id: string
  taskId: string
  pluginId: string
  status: PluginTaskExecutionStatus
  scheduledAt: Date
  startedAt?: Date
  completedAt?: Date
  duration?: number
  result?: PluginTaskResult
  attemptNumber: number
  error?: {
    message: string
    stack?: string
  }
  logs?: Array<{
    timestamp: Date
    level: "debug" | "info" | "warn" | "error"
    message: string
    data?: Record<string, unknown>
  }>
}

// =============================================================================
// Input Types
// =============================================================================

export interface CreatePluginTaskInput {
  name: string
  description?: string
  trigger: PluginTaskTrigger
  handler: string
  handlerArgs?: Record<string, unknown>
  enabled?: boolean
  retry?: {
    maxAttempts: number
    delaySeconds: number
    backoffMultiplier?: number
  }
  timeout?: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface UpdatePluginTaskInput {
  name?: string
  description?: string
  trigger?: PluginTaskTrigger
  handler?: string
  handlerArgs?: Record<string, unknown>
  retry?: {
    maxAttempts: number
    delaySeconds: number
    backoffMultiplier?: number
  }
  timeout?: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface PluginTaskFilter {
  status?: PluginTaskStatus | PluginTaskStatus[]
  handler?: string
  tags?: string[]
  name?: string
  hasErrors?: boolean
  limit?: number
  offset?: number
}

// =============================================================================
// Scheduler API
// =============================================================================

export interface PluginSchedulerAPI {
  // Task Management
  createTask: (input: CreatePluginTaskInput) => Promise<PluginScheduledTask>
  updateTask: (taskId: string, input: UpdatePluginTaskInput) => Promise<PluginScheduledTask | null>
  deleteTask: (taskId: string) => Promise<boolean>
  getTask: (taskId: string) => Promise<PluginScheduledTask | null>
  listTasks: (filter?: PluginTaskFilter) => Promise<PluginScheduledTask[]>

  // Task Control
  pauseTask: (taskId: string) => Promise<boolean>
  resumeTask: (taskId: string) => Promise<boolean>
  runTaskNow: (taskId: string, args?: Record<string, unknown>) => Promise<string>
  cancelExecution: (executionId: string) => Promise<boolean>

  // Execution History
  getExecutions: (taskId: string, limit?: number) => Promise<PluginTaskExecution[]>
  getExecution: (executionId: string) => Promise<PluginTaskExecution | null>
  getLatestExecution: (taskId: string) => Promise<PluginTaskExecution | null>

  // Handler Registration
  registerHandler: (name: string, handler: PluginTaskHandler) => () => void
  unregisterHandler: (name: string) => void
  hasHandler: (name: string) => boolean
  getHandlers: () => string[]
}
