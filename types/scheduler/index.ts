/**
 * Scheduler Type Definitions
 * Types for scheduled tasks, cron expressions, and task execution
 */

// Task trigger types
export type TaskTriggerType = "cron" | "interval" | "once" | "event"

// Task types that can be scheduled. `skill` is a cognia-next-specific addition:
// we route skill-driven Claude sessions through a dedicated executor in
// `lib/scheduler/executors`. The other variants are kept for source-fidelity
// with Cognia even though only chat / agent / skill / script / custom / plugin
// have backing executors here.
export type ScheduledTaskType =
  | "workflow"
  | "agent"
  | "sync"
  | "backup"
  | "custom"
  | "plugin"
  | "script"
  | "test"
  | "ai-generation"
  | "chat"
  | "im-push"
  | "skill"

// Task execution status
export type TaskExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"

export type TaskExecutionTriggerSource =
  | "schedule"
  | "run-now"
  | "retry"
  | "event"
  | "dependency"
  | "catch-up"

export type TaskExecutionTerminalReason =
  | "completed"
  | "executor-failure"
  | "execution-error"
  | "execution-timeout"
  | "concurrency-blocked"
  | "retry-chain-active"
  | "missed-run-skipped"
  | "once-expired"
  | "retry-scheduled"

// Task status
export type ScheduledTaskStatus = "active" | "paused" | "disabled" | "expired"

// Notification channels
export type NotificationChannel = "desktop" | "toast" | "webhook" | "none"

export type BackupTaskType = "full" | "sessions" | "settings" | "plugins" | "all"

export type BackupDestination = "local" | "webdav" | "github" | "googledrive" | "convex" | "all"

export interface BackupSelectionOptions {
  includeSessions?: boolean
  includeSettings?: boolean
  includeArtifacts?: boolean
  includeIndexedDB?: boolean
}

export interface BackupTaskPayload extends Record<string, unknown> {
  backupType?: BackupTaskType
  destination?: BackupDestination
  options?: BackupSelectionOptions
}

export type ScheduledTaskPayload = Record<string, unknown> | BackupTaskPayload

/**
 * Cron expression parts for validation and display
 */
export interface CronParts {
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

/**
 * Cron preset for quick selection
 */
export interface CronPreset {
  id: string
  label: string
  labelZh: string
  expression: string
  description: string
}

export interface CronExpressionOption {
  id: string
  label: string
  value: string
  description?: string
}

/**
 * Task trigger configuration
 */
export interface TaskTrigger {
  type: TaskTriggerType
  /** Cron expression (for 'cron' type) */
  cronExpression?: string
  /** Interval in milliseconds (for 'interval' type) */
  intervalMs?: number
  /** Specific time to run (for 'once' type) */
  runAt?: Date
  /** Event type to listen for (for 'event' type) */
  eventType?: string
  /** Event source filter */
  eventSource?: string
  /** Timezone for cron expressions */
  timezone?: string
  /** Task IDs that must complete successfully before this task runs */
  dependsOn?: string[]
}

/**
 * Task notification configuration
 */
export interface TaskNotificationConfig {
  /** Notify when task starts */
  onStart: boolean
  /** Notify when task completes successfully */
  onComplete: boolean
  /** Notify when task fails */
  onError: boolean
  /** Notify on progress (for long-running tasks) */
  onProgress?: boolean
  /** Notification channels to use */
  channels?: NotificationChannel[]
  /** Webhook URL for webhook notifications */
  webhookUrl?: string
}

/**
 * Task execution configuration
 */
export interface TaskExecutionConfig {
  /** Maximum execution time in milliseconds */
  timeout: number
  /** Number of retry attempts on failure */
  maxRetries: number
  /** Base delay between retries in milliseconds (used with exponential backoff) */
  retryDelay: number
  /** Maximum retry delay in milliseconds (caps exponential backoff) */
  maxRetryDelay?: number
  /** Whether to run missed executions on startup */
  runMissedOnStartup: boolean
  /** Maximum number of missed executions to run */
  maxMissedRuns?: number
  /** Whether to allow concurrent executions */
  allowConcurrent: boolean
}

/**
 * Scheduled task definition
 */
export interface ScheduledTask {
  id: string
  name: string
  description?: string
  type: ScheduledTaskType
  trigger: TaskTrigger
  payload?: ScheduledTaskPayload
  config: TaskExecutionConfig
  notification: TaskNotificationConfig
  status: ScheduledTaskStatus
  /** Tags for categorization */
  tags?: string[]
  /** Last execution time */
  lastRunAt?: Date
  /** Next scheduled execution time */
  nextRunAt?: Date
  /** Total number of executions */
  runCount: number
  /** Number of successful executions */
  successCount: number
  /** Number of failed executions */
  failureCount: number
  /** Last error message */
  lastError?: string
  /** Most recent terminal outcome reason */
  lastTerminalReason?: TaskExecutionTerminalReason | string
  /** Timestamp of most recent terminal outcome */
  lastTerminalAt?: Date
  createdAt: Date
  updatedAt: Date
}

/**
 * Task execution record
 */
export interface TaskExecution {
  id: string
  taskId: string
  taskName: string
  taskType: ScheduledTaskType
  status: TaskExecutionStatus
  input?: ScheduledTaskPayload
  output?: Record<string, unknown>
  error?: string
  /** Retry attempt number (0 = first attempt) */
  retryAttempt: number
  /** Execution duration in milliseconds */
  duration?: number
  /** Scheduled execution slot (if execution was schedule-bound) */
  scheduledFor?: Date
  /** What initiated this execution */
  triggerSource?: TaskExecutionTriggerSource
  /** Structured terminal outcome reason */
  terminalReason?: TaskExecutionTerminalReason | string
  /** Timestamp when a retry attempt was scheduled */
  retryScheduledAt?: Date
  startedAt: Date
  completedAt?: Date
  /** Logs from execution */
  logs: TaskExecutionLog[]
}

/**
 * Task execution log entry
 */
export interface TaskExecutionLog {
  id: string
  timestamp: Date
  level: "debug" | "info" | "warn" | "error"
  message: string
  data?: unknown
}

/**
 * Input for creating a scheduled task
 */
export interface CreateScheduledTaskInput {
  name: string
  description?: string
  type: ScheduledTaskType
  trigger: TaskTrigger
  payload?: ScheduledTaskPayload
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  tags?: string[]
}

/**
 * Input for updating a scheduled task
 */
export interface UpdateScheduledTaskInput {
  name?: string
  description?: string
  trigger?: Partial<TaskTrigger>
  payload?: ScheduledTaskPayload
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  status?: ScheduledTaskStatus
  tags?: string[]
}

/**
 * Task filter options
 */
export interface TaskFilter {
  types?: ScheduledTaskType[]
  statuses?: ScheduledTaskStatus[]
  /** Single status shorthand filter */
  status?: ScheduledTaskStatus
  tags?: string[]
  search?: string
}

/**
 * Task statistics
 */
export interface TaskStatistics {
  totalTasks: number
  activeTasks: number
  pausedTasks: number
  totalExecutions: number
  successfulExecutions: number
  failedExecutions: number
  averageDuration: number
  upcomingExecutions: number
}

/**
 * Default execution configuration
 */
export const DEFAULT_EXECUTION_CONFIG: TaskExecutionConfig = {
  timeout: 300000, // 5 minutes
  maxRetries: 3,
  retryDelay: 5000, // 5 seconds base delay
  maxRetryDelay: 60000, // 1 minute cap for exponential backoff
  runMissedOnStartup: false,
  maxMissedRuns: 1,
  allowConcurrent: false,
}

/**
 * Default notification configuration
 */
export const DEFAULT_NOTIFICATION_CONFIG: TaskNotificationConfig = {
  onStart: false,
  onComplete: true,
  onError: true,
  onProgress: false,
  channels: ["toast"],
}

/**
 * Common cron presets
 */
export const CRON_PRESETS: CronPreset[] = [
  {
    id: "every-minute",
    label: "Every minute",
    labelZh: "每分钟",
    expression: "* * * * *",
    description: "Runs every minute",
  },
  {
    id: "every-5-minutes",
    label: "Every 5 minutes",
    labelZh: "每5分钟",
    expression: "*/5 * * * *",
    description: "Runs every 5 minutes",
  },
  {
    id: "every-15-minutes",
    label: "Every 15 minutes",
    labelZh: "每15分钟",
    expression: "*/15 * * * *",
    description: "Runs every 15 minutes",
  },
  {
    id: "every-30-minutes",
    label: "Every 30 minutes",
    labelZh: "每30分钟",
    expression: "*/30 * * * *",
    description: "Runs every 30 minutes",
  },
  {
    id: "every-hour",
    label: "Every hour",
    labelZh: "每小时",
    expression: "0 * * * *",
    description: "Runs at the start of every hour",
  },
  {
    id: "every-2-hours",
    label: "Every 2 hours",
    labelZh: "每2小时",
    expression: "0 */2 * * *",
    description: "Runs every 2 hours",
  },
  {
    id: "every-6-hours",
    label: "Every 6 hours",
    labelZh: "每6小时",
    expression: "0 */6 * * *",
    description: "Runs every 6 hours",
  },
  {
    id: "every-12-hours",
    label: "Every 12 hours",
    labelZh: "每12小时",
    expression: "0 */12 * * *",
    description: "Runs every 12 hours",
  },
  {
    id: "daily-midnight",
    label: "Daily at midnight",
    labelZh: "每天午夜",
    expression: "0 0 * * *",
    description: "Runs daily at 00:00",
  },
  {
    id: "daily-6am",
    label: "Daily at 6am",
    labelZh: "每天早上6点",
    expression: "0 6 * * *",
    description: "Runs daily at 06:00",
  },
  {
    id: "daily-9am",
    label: "Daily at 9am",
    labelZh: "每天早上9点",
    expression: "0 9 * * *",
    description: "Runs daily at 09:00",
  },
  {
    id: "daily-noon",
    label: "Daily at noon",
    labelZh: "每天中午",
    expression: "0 12 * * *",
    description: "Runs daily at 12:00",
  },
  {
    id: "daily-6pm",
    label: "Daily at 6pm",
    labelZh: "每天下午6点",
    expression: "0 18 * * *",
    description: "Runs daily at 18:00",
  },
  {
    id: "weekdays-9am",
    label: "Weekdays at 9am",
    labelZh: "工作日早上9点",
    expression: "0 9 * * 1-5",
    description: "Runs Monday to Friday at 09:00",
  },
  {
    id: "weekly-monday",
    label: "Every Monday at 9am",
    labelZh: "每周一早上9点",
    expression: "0 9 * * 1",
    description: "Runs every Monday at 09:00",
  },
  {
    id: "weekly-sunday",
    label: "Every Sunday at midnight",
    labelZh: "每周日午夜",
    expression: "0 0 * * 0",
    description: "Runs every Sunday at 00:00",
  },
  {
    id: "monthly-first",
    label: "First day of month",
    labelZh: "每月第一天",
    expression: "0 0 1 * *",
    description: "Runs on the 1st of every month at 00:00",
  },
  {
    id: "monthly-15th",
    label: "15th of month",
    labelZh: "每月15日",
    expression: "0 0 15 * *",
    description: "Runs on the 15th of every month at 00:00",
  },
]

/**
 * Timezone options
 */
export const TIMEZONE_OPTIONS = [
  { value: "UTC", label: "UTC", offset: "+00:00" },
  { value: "Asia/Shanghai", label: "China Standard Time (Shanghai)", offset: "+08:00" },
  { value: "Asia/Tokyo", label: "Japan Standard Time (Tokyo)", offset: "+09:00" },
  { value: "Asia/Seoul", label: "Korea Standard Time (Seoul)", offset: "+09:00" },
  { value: "Asia/Singapore", label: "Singapore Time", offset: "+08:00" },
  { value: "America/New_York", label: "Eastern Time (New York)", offset: "-05:00" },
  { value: "America/Chicago", label: "Central Time (Chicago)", offset: "-06:00" },
  { value: "America/Denver", label: "Mountain Time (Denver)", offset: "-07:00" },
  { value: "America/Los_Angeles", label: "Pacific Time (Los Angeles)", offset: "-08:00" },
  { value: "Europe/London", label: "British Time (London)", offset: "+00:00" },
  { value: "Europe/Paris", label: "Central European Time (Paris)", offset: "+01:00" },
  { value: "Europe/Berlin", label: "Central European Time (Berlin)", offset: "+01:00" },
  { value: "Australia/Sydney", label: "Australian Eastern Time (Sydney)", offset: "+10:00" },
]

export function getCronExpressionOptions(limit?: number): CronExpressionOption[] {
  const presets = typeof limit === "number" ? CRON_PRESETS.slice(0, limit) : CRON_PRESETS
  return presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    value: preset.expression,
    description: preset.description,
  }))
}

// ============================================================================
// Permission types
// ============================================================================

/** Source that initiated task creation */
export type TaskCreationSource = "user" | "agent" | "plugin" | "system"

/**
 * Permission policy for the app-level scheduler.
 * Controls what agents and plugins can do with scheduled tasks.
 */
export interface SchedulerPermissionPolicy {
  /** Whether agents can create tasks without user confirmation dialog */
  agentAutoCreate: boolean
  /** Task types that always require explicit user confirmation before creation */
  confirmationRequired: ScheduledTaskType[]
  /** Whether script-type tasks are allowed at all */
  scriptTasksEnabled: boolean
  /** Maximum number of tasks that can exist per creation source */
  maxTasksPerSource: number
  /** Maximum number of concurrent task executions globally */
  maxConcurrentExecutions: number
}

export const DEFAULT_PERMISSION_POLICY: SchedulerPermissionPolicy = {
  agentAutoCreate: false,
  confirmationRequired: ["script", "agent"],
  scriptTasksEnabled: true,
  maxTasksPerSource: 50,
  maxConcurrentExecutions: 5,
}

// Re-export system scheduler types with aliased names to avoid conflicts
export {
  // Types
  type SystemTaskId,
  type RunLevel,
  type SystemTaskStatus,
  type RiskLevel,
  type TaskOperation,
  type CronTrigger as SystemCronTrigger,
  type IntervalTrigger as SystemIntervalTrigger,
  type OnceTrigger as SystemOnceTrigger,
  type OnBootTrigger,
  type OnLogonTrigger,
  type OnEventTrigger,
  type SystemTaskTrigger,
  type ExecuteScriptAction,
  type RunCommandAction,
  type LaunchAppAction,
  type SystemTaskAction,
  type TaskRunResult,
  type SystemTask,
  type CreateSystemTaskInput,
  type TaskConfirmationDetails,
  type TaskConfirmationRequest,
  type SchedulerCapabilities,
  type ValidationResult,
  type TaskOperationResponse,
  // Constants
  DEFAULT_SCRIPT_SETTINGS,
  SCRIPT_LANGUAGES,
  RISK_LEVEL_INFO,
  // Functions
  isTaskOperationSuccess,
  isConfirmationRequired,
  isTaskOperationError,
} from "./system-scheduler"
