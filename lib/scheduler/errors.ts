/**
 * Scheduler Error Types
 * Structured error class with error codes for the scheduler module
 */

export type SchedulerErrorCode =
  | "INIT_FAILED"
  | "TASK_NOT_FOUND"
  | "EXECUTOR_NOT_FOUND"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_FAILED"
  | "EXECUTION_CANCELLED"
  | "CONCURRENT_EXECUTION"
  | "INVALID_CRON"
  | "INVALID_TRIGGER"
  | "INVALID_TIMEZONE"
  | "DB_ERROR"
  | "NOTIFICATION_FAILED"
  | "WEBHOOK_FAILED"
  | "SCRIPT_VALIDATION_FAILED"
  | "PLUGIN_HANDLER_NOT_FOUND"
  | "DEPRECATED_TASK_TYPE"
  | "UNKNOWN"

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    code: SchedulerErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message)
    this.name = "SchedulerError"
    this.code = code
    this.details = details
    if (cause) {
      this.cause = cause
    }
  }

  static taskNotFound(taskId: string): SchedulerError {
    return new SchedulerError("TASK_NOT_FOUND", `Task not found: ${taskId}`, { taskId })
  }

  static invalidTrigger(message: string, details?: Record<string, unknown>): SchedulerError {
    return new SchedulerError("INVALID_TRIGGER", message, details)
  }

  static invalidCron(expression: string, reason?: string): SchedulerError {
    return new SchedulerError(
      "INVALID_CRON",
      reason
        ? `Invalid cron expression "${expression}": ${reason}`
        : `Invalid cron expression: ${expression}`,
      { expression, reason }
    )
  }

  static invalidTimezone(timezone: string): SchedulerError {
    return new SchedulerError("INVALID_TIMEZONE", `Invalid timezone: ${timezone}`, { timezone })
  }

  static executorNotFound(taskType: string): SchedulerError {
    return new SchedulerError(
      "EXECUTOR_NOT_FOUND",
      `No executor registered for task type: ${taskType}`,
      { taskType }
    )
  }

  static deprecatedTaskType(taskType: string): SchedulerError {
    return new SchedulerError(
      "DEPRECATED_TASK_TYPE",
      `Task type "${taskType}" is deprecated and cannot be created; use "chat" instead`,
      { taskType }
    )
  }

  static executionTimeout(taskName: string, timeoutMs: number): SchedulerError {
    return new SchedulerError("EXECUTION_TIMEOUT", `Execution timed out after ${timeoutMs}ms`, {
      taskName,
      timeoutMs,
    })
  }

  /** Raised when a running execution is aborted by lifecycle or overlap policy. */
  static executionCancelled(
    taskName: string,
    reason: "overlap-cancelled" | "scheduler-stopped" | "task-deleted" = "overlap-cancelled"
  ): SchedulerError {
    return new SchedulerError(
      "EXECUTION_CANCELLED",
      reason === "scheduler-stopped"
        ? "Execution cancelled because the scheduler stopped"
        : reason === "task-deleted"
          ? "Execution cancelled because the task was deleted"
          : "Execution cancelled by a newer start (cancel-previous overlap policy)",
      { taskName, reason }
    )
  }

  static initFailed(reason: string, cause?: Error): SchedulerError {
    return new SchedulerError(
      "INIT_FAILED",
      `Scheduler initialization failed: ${reason}`,
      undefined,
      cause
    )
  }

  static dbError(operation: string, cause?: Error): SchedulerError {
    return new SchedulerError(
      "DB_ERROR",
      `Database operation failed: ${operation}`,
      { operation },
      cause
    )
  }

  static webhookFailed(url: string, status?: number, cause?: Error): SchedulerError {
    return new SchedulerError(
      "WEBHOOK_FAILED",
      `Webhook notification failed for ${url}`,
      { url, status },
      cause
    )
  }
}
