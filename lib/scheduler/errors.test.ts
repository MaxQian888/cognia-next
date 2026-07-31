/**
 * Tests for SchedulerError class and factory helpers.
 */

import { SchedulerError, type SchedulerErrorCode } from "./errors"

describe("SchedulerError", () => {
  it("captures code, message, and is an Error subclass", () => {
    const err = new SchedulerError("UNKNOWN", "something broke")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(SchedulerError)
    expect(err.name).toBe("SchedulerError")
    expect(err.code).toBe<SchedulerErrorCode>("UNKNOWN")
    expect(err.message).toBe("something broke")
    expect(err.details).toBeUndefined()
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  it("carries optional details map", () => {
    const err = new SchedulerError("DB_ERROR", "boom", { table: "tasks" })
    expect(err.details).toEqual({ table: "tasks" })
  })

  it("attaches a cause when provided", () => {
    const cause = new Error("underlying")
    const err = new SchedulerError("INIT_FAILED", "wrap", undefined, cause)
    expect((err as Error & { cause?: unknown }).cause).toBe(cause)
  })

  describe("factories", () => {
    it("taskNotFound() builds the correct error", () => {
      const err = SchedulerError.taskNotFound("task-1")
      expect(err.code).toBe("TASK_NOT_FOUND")
      expect(err.message).toBe("Task not found: task-1")
      expect(err.details).toEqual({ taskId: "task-1" })
    })

    it("invalidTrigger() forwards details", () => {
      const err = SchedulerError.invalidTrigger("bad", { reason: "x" })
      expect(err.code).toBe("INVALID_TRIGGER")
      expect(err.message).toBe("bad")
      expect(err.details).toEqual({ reason: "x" })
    })

    it("invalidTrigger() with no details", () => {
      const err = SchedulerError.invalidTrigger("bad")
      expect(err.details).toBeUndefined()
    })

    it("invalidCron() includes reason when provided", () => {
      const err = SchedulerError.invalidCron("* * *", "too few fields")
      expect(err.code).toBe("INVALID_CRON")
      expect(err.message).toBe('Invalid cron expression "* * *": too few fields')
      expect(err.details).toEqual({ expression: "* * *", reason: "too few fields" })
    })

    it("invalidCron() omits reason segment when none given", () => {
      const err = SchedulerError.invalidCron("* * *")
      expect(err.message).toBe("Invalid cron expression: * * *")
      expect(err.details).toEqual({ expression: "* * *", reason: undefined })
    })

    it("invalidTimezone() formats the message", () => {
      const err = SchedulerError.invalidTimezone("Foo/Bar")
      expect(err.code).toBe("INVALID_TIMEZONE")
      expect(err.message).toBe("Invalid timezone: Foo/Bar")
      expect(err.details).toEqual({ timezone: "Foo/Bar" })
    })

    it("executorNotFound() formats the message", () => {
      const err = SchedulerError.executorNotFound("webhook")
      expect(err.code).toBe("EXECUTOR_NOT_FOUND")
      expect(err.message).toBe("No executor registered for task type: webhook")
      expect(err.details).toEqual({ taskType: "webhook" })
    })

    it("executionTimeout() formats with milliseconds", () => {
      const err = SchedulerError.executionTimeout("Daily Sync", 30000)
      expect(err.code).toBe("EXECUTION_TIMEOUT")
      expect(err.message).toBe("Execution timed out after 30000ms")
      expect(err.details).toEqual({ taskName: "Daily Sync", timeoutMs: 30000 })
    })

    it.each([
      [
        undefined,
        "Execution cancelled by a newer start (cancel-previous overlap policy)",
        "overlap-cancelled",
      ],
      [
        "scheduler-stopped" as const,
        "Execution cancelled because the scheduler stopped",
        "scheduler-stopped",
      ],
      ["task-deleted" as const, "Execution cancelled because the task was deleted", "task-deleted"],
    ])("executionCancelled() describes the %s reason", (reason, message, expectedReason) => {
      const err =
        reason === undefined
          ? SchedulerError.executionCancelled("Daily Sync")
          : SchedulerError.executionCancelled("Daily Sync", reason)

      expect(err.code).toBe("EXECUTION_CANCELLED")
      expect(err.message).toBe(message)
      expect(err.details).toEqual({ taskName: "Daily Sync", reason: expectedReason })
    })

    it("initFailed() preserves cause", () => {
      const cause = new Error("inner")
      const err = SchedulerError.initFailed("config bad", cause)
      expect(err.code).toBe("INIT_FAILED")
      expect(err.message).toBe("Scheduler initialization failed: config bad")
      expect((err as Error & { cause?: unknown }).cause).toBe(cause)
    })

    it("initFailed() works without a cause", () => {
      const err = SchedulerError.initFailed("config bad")
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined()
    })

    it("dbError() includes operation in details and cause", () => {
      const cause = new Error("disk full")
      const err = SchedulerError.dbError("createTask", cause)
      expect(err.code).toBe("DB_ERROR")
      expect(err.message).toBe("Database operation failed: createTask")
      expect(err.details).toEqual({ operation: "createTask" })
      expect((err as Error & { cause?: unknown }).cause).toBe(cause)
    })

    it("webhookFailed() carries url, status, and cause", () => {
      const cause = new Error("network")
      const err = SchedulerError.webhookFailed("https://example.com/hook", 503, cause)
      expect(err.code).toBe("WEBHOOK_FAILED")
      expect(err.message).toBe("Webhook notification failed for https://example.com/hook")
      expect(err.details).toEqual({ url: "https://example.com/hook", status: 503 })
      expect((err as Error & { cause?: unknown }).cause).toBe(cause)
    })

    it("webhookFailed() works with only the URL", () => {
      const err = SchedulerError.webhookFailed("https://example.com/hook")
      expect(err.details).toEqual({ url: "https://example.com/hook", status: undefined })
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined()
    })
  })
})
