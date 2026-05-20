/**
 * @jest-environment jsdom
 */

import {
  getTaskScheduler,
  initTaskScheduler,
  stopTaskScheduler,
  registerTaskExecutor,
  unregisterTaskExecutor,
  TaskSchedulerImpl,
} from "./task-scheduler"
import type { ScheduledTask, CreateScheduledTaskInput } from "@/types/scheduler"

// Mock plugin lifecycle hooks
const mockDispatchOnScheduledTaskStart = jest.fn()
const mockDispatchOnScheduledTaskComplete = jest.fn()
const mockDispatchOnScheduledTaskError = jest.fn()
jest.mock("@/lib/plugin", () => ({
  getPluginLifecycleHooks: () => ({
    dispatchOnScheduledTaskStart: mockDispatchOnScheduledTaskStart,
    dispatchOnScheduledTaskComplete: mockDispatchOnScheduledTaskComplete,
    dispatchOnScheduledTaskError: mockDispatchOnScheduledTaskError,
  }),
}))

// Mock dependencies
jest.mock("./scheduler-db", () => ({
  schedulerDb: {
    getTasksByStatus: jest.fn().mockResolvedValue([]),
    createTask: jest.fn().mockResolvedValue(undefined),
    updateTask: jest.fn().mockResolvedValue(undefined),
    deleteTask: jest.fn().mockResolvedValue(true),
    getTask: jest.fn().mockResolvedValue(null),
    getAllTasks: jest.fn().mockResolvedValue([]),
    getActiveEventTasks: jest.fn().mockResolvedValue([]),
    createExecution: jest.fn().mockResolvedValue(undefined),
    updateExecution: jest.fn().mockResolvedValue(undefined),
    getTaskExecutions: jest.fn().mockResolvedValue([]),
    cleanupOldExecutions: jest.fn().mockResolvedValue(0),
  },
}))

jest.mock("./notification-integration", () => ({
  notifyTaskEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("./cron-parser", () => ({
  validateCronExpression: jest.fn().mockReturnValue({ valid: true }),
  getNextCronTime: jest.fn().mockReturnValue(new Date(Date.now() + 60000)),
}))

jest.mock("@/lib/logger", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return {
    loggers: {
      app: stub,
      scheduler: stub,
      store: stub,
      plugin: stub,
    },
    createLogger: () => stub,
  }
})

import { schedulerDb } from "./scheduler-db"
import { validateCronExpression } from "./cron-parser"

const mockSchedulerDb = schedulerDb as jest.Mocked<typeof schedulerDb>

describe("TaskScheduler", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    stopTaskScheduler()
  })

  afterEach(() => {
    jest.useRealTimers()
    stopTaskScheduler()
  })

  describe("getTaskScheduler", () => {
    it("should return singleton instance", () => {
      const scheduler1 = getTaskScheduler()
      const scheduler2 = getTaskScheduler()
      expect(scheduler1).toBe(scheduler2)
    })
  })

  describe("initTaskScheduler", () => {
    it("should initialize scheduler", async () => {
      await initTaskScheduler()
      const status = getTaskScheduler().getStatus()
      expect(status.initialized).toBe(true)
    })

    it("should load active tasks", async () => {
      mockSchedulerDb.getTasksByStatus.mockResolvedValueOnce([])
      await initTaskScheduler()
      expect(mockSchedulerDb.getTasksByStatus).toHaveBeenCalledWith("active")
    })
  })

  describe("stopTaskScheduler", () => {
    it("should stop scheduler", async () => {
      await initTaskScheduler()
      stopTaskScheduler()
      const status = getTaskScheduler().getStatus()
      expect(status.initialized).toBe(false)
    })
  })

  describe("registerTaskExecutor", () => {
    it("should register executor for task type", () => {
      const executor = jest.fn().mockResolvedValue({ success: true })
      registerTaskExecutor("test-type", executor)
      // Executor should be registered (verified indirectly through task execution)
    })
  })

  describe("unregisterTaskExecutor", () => {
    it("should unregister executor", () => {
      const executor = jest.fn()
      registerTaskExecutor("test-type", executor)
      unregisterTaskExecutor("test-type")
      // Executor should be unregistered
    })
  })

  describe("TaskSchedulerImpl", () => {
    let scheduler: TaskSchedulerImpl

    beforeEach(async () => {
      scheduler = getTaskScheduler() as TaskSchedulerImpl
      await scheduler.initialize()
    })

    describe("createTask", () => {
      it("should create a new task", async () => {
        const input: CreateScheduledTaskInput = {
          name: "Test Task",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
        }

        const task = await scheduler.createTask(input)

        expect(task).toHaveProperty("id")
        expect(task.name).toBe("Test Task")
        expect(task.status).toBe("active")
        expect(mockSchedulerDb.createTask).toHaveBeenCalled()
      })

      it("should calculate next run time for interval triggers", async () => {
        const input: CreateScheduledTaskInput = {
          name: "Interval Task",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
        }

        const task = await scheduler.createTask(input)
        expect(task.nextRunAt).toBeDefined()
      })

      it("should handle cron triggers", async () => {
        const input: CreateScheduledTaskInput = {
          name: "Cron Task",
          type: "test",
          trigger: { type: "cron", cronExpression: "0 * * * *" },
        }

        const task = await scheduler.createTask(input)
        expect(task.trigger.type).toBe("cron")
      })

      it("should reject invalid cron trigger", async () => {
        ;(validateCronExpression as jest.Mock).mockReturnValueOnce({
          valid: false,
          error: "bad cron",
        })

        await expect(
          scheduler.createTask({
            name: "Invalid Cron",
            type: "test",
            trigger: { type: "cron", cronExpression: "invalid cron" },
          })
        ).rejects.toThrow("Invalid cron expression")
      })

      it("should reject one-time trigger in the past", async () => {
        const past = new Date(Date.now() - 60_000)
        await expect(
          scheduler.createTask({
            name: "Past Once",
            type: "test",
            trigger: { type: "once", runAt: past },
          })
        ).rejects.toThrow("must be in the future")
      })

      it("should reject scheduled chat task without prompt payload", async () => {
        await expect(
          scheduler.createTask({
            name: "Invalid Chat Task",
            type: "chat",
            trigger: { type: "cron", cronExpression: "0 9 * * *" },
            payload: {},
          })
        ).rejects.toThrow("prompt")
      })

      it("should reject scheduled agent task without prompt payload", async () => {
        await expect(
          scheduler.createTask({
            name: "Invalid Agent Task",
            type: "agent",
            trigger: { type: "cron", cronExpression: "0 9 * * *" },
            payload: {},
          })
        ).rejects.toThrow("prompt")
      })
    })

    describe("updateTask", () => {
      it("should return null for non-existent task", async () => {
        mockSchedulerDb.getTask.mockResolvedValueOnce(null)
        const result = await scheduler.updateTask("non-existent", { name: "Updated" })
        expect(result).toBeNull()
      })

      it("should update existing task", async () => {
        const existingTask: ScheduledTask = {
          id: "task-1",
          name: "Original",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(existingTask)

        const result = await scheduler.updateTask("task-1", { name: "Updated" })

        expect(result?.name).toBe("Updated")
        expect(mockSchedulerDb.updateTask).toHaveBeenCalled()
      })

      it("should reject invalid conversational payload during update", async () => {
        const existingTask: ScheduledTask = {
          id: "task-chat-1",
          name: "Scheduled Chat",
          type: "chat",
          trigger: { type: "interval", intervalMs: 60000 },
          payload: { message: "hello" },
          config: {
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(existingTask)

        await expect(
          scheduler.updateTask("task-chat-1", {
            payload: { message: "   " },
          })
        ).rejects.toThrow("prompt")
      })
    })

    describe("deleteTask", () => {
      it("should delete task", async () => {
        mockSchedulerDb.deleteTask.mockResolvedValueOnce(true)
        const result = await scheduler.deleteTask("task-1")
        expect(result).toBe(true)
      })
    })

    describe("getTask", () => {
      it("should return task by ID", async () => {
        const task: ScheduledTask = {
          id: "task-1",
          name: "Test",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(task)

        const result = await scheduler.getTask("task-1")
        expect(result?.id).toBe("task-1")
      })
    })

    describe("getAllTasks", () => {
      it("should return all tasks", async () => {
        mockSchedulerDb.getAllTasks.mockResolvedValueOnce([])
        const result = await scheduler.getAllTasks()
        expect(Array.isArray(result)).toBe(true)
      })
    })

    describe("pauseTask", () => {
      it("should return false for non-existent task", async () => {
        mockSchedulerDb.getTask.mockResolvedValueOnce(null)
        const result = await scheduler.pauseTask("non-existent")
        expect(result).toBe(false)
      })

      it("should pause existing task", async () => {
        const task: ScheduledTask = {
          id: "task-1",
          name: "Test",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(task)

        const result = await scheduler.pauseTask("task-1")
        expect(result).toBe(true)
        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({ status: "paused" })
        )
      })
    })

    describe("resumeTask", () => {
      it("should return false for non-existent task", async () => {
        mockSchedulerDb.getTask.mockResolvedValueOnce(null)
        const result = await scheduler.resumeTask("non-existent")
        expect(result).toBe(false)
      })

      it("should return false for non-paused task", async () => {
        const task: ScheduledTask = {
          id: "task-1",
          name: "Test",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(task)

        const result = await scheduler.resumeTask("task-1")
        expect(result).toBe(false)
      })
    })

    describe("runTaskNow", () => {
      it("should return null for non-existent task", async () => {
        mockSchedulerDb.getTask.mockResolvedValueOnce(null)
        const result = await scheduler.runTaskNow("non-existent")
        expect(result).toBeNull()
      })

      it("should execute task immediately", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const task: ScheduledTask = {
          id: "task-1",
          name: "Test",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: true,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(task)

        const result = await scheduler.runTaskNow("task-1")
        expect(result).toBeDefined()
        expect(executor).toHaveBeenCalled()
      })
    })

    describe("lifecycle integration flow", () => {
      it("should cover create -> pause -> resume -> run-now failure/recovery", async () => {
        const flakyExecutor = jest
          .fn()
          .mockResolvedValueOnce({ success: false, error: "transient failure" })
          .mockResolvedValueOnce({ success: true, output: { ok: true } })
        registerTaskExecutor("test", flakyExecutor)

        const created = await scheduler.createTask({
          name: "Lifecycle Task",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 1,
            retryDelay: 10,
            timeout: 30000,
            allowConcurrent: true,
            runMissedOnStartup: true,
          },
        })

        mockSchedulerDb.getTask.mockResolvedValueOnce(created)
        const paused = await scheduler.pauseTask(created.id)
        expect(paused).toBe(true)

        mockSchedulerDb.getTask.mockResolvedValueOnce({ ...created, status: "paused" })
        const resumed = await scheduler.resumeTask(created.id)
        expect(resumed).toBe(true)

        mockSchedulerDb.getTask.mockResolvedValueOnce({ ...created, status: "active" })
        await scheduler.runTaskNow(created.id)
        await jest.advanceTimersByTimeAsync(20)

        expect(flakyExecutor).toHaveBeenCalledTimes(2)
        expect(mockSchedulerDb.createExecution).toHaveBeenCalledTimes(2)
        expect(mockSchedulerDb.createExecution).toHaveBeenCalledWith(
          expect.objectContaining({ triggerSource: "run-now" })
        )
        expect(mockSchedulerDb.updateExecution).toHaveBeenCalledWith(
          expect.objectContaining({ status: "completed" })
        )
      })

      it("should skip overlapping run-now executions when concurrency is disabled", async () => {
        let resolveFirstExecution:
          | ((value: {
              success: boolean
              output?: Record<string, unknown>
              error?: string
            }) => void)
          | undefined
        const blockingExecutor = jest.fn().mockImplementation(
          () =>
            new Promise<{ success: boolean }>((resolve) => {
              resolveFirstExecution = resolve
            })
        )
        registerTaskExecutor("test", blockingExecutor)

        const task: ScheduledTask = {
          id: "task-concurrency-1",
          name: "Concurrency Guard Task",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 0,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }

        mockSchedulerDb.getTask.mockResolvedValue(task)

        const firstExecution = scheduler.runTaskNow(task.id)
        await Promise.resolve()

        const secondExecution = await scheduler.runTaskNow(task.id)

        expect(secondExecution).toEqual(
          expect.objectContaining({
            status: "skipped",
            terminalReason: "concurrency-blocked",
          })
        )

        resolveFirstExecution?.({ success: true })
        await firstExecution
      })
    })

    describe("missed-run reconciliation", () => {
      it("should skip overdue recurring task when runMissedOnStartup is disabled", async () => {
        const overdueTask: ScheduledTask = {
          id: "overdue-1",
          name: "Overdue Task",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 0,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: false,
            maxMissedRuns: 2,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          nextRunAt: new Date(Date.now() - 5 * 60000),
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(Date.now() - 60 * 60000),
          updatedAt: new Date(),
        }

        mockSchedulerDb.getTasksByStatus.mockResolvedValueOnce([overdueTask])

        await (scheduler as unknown as { checkMissedTasks: () => Promise<void> }).checkMissedTasks()

        expect(mockSchedulerDb.createExecution).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "skipped",
            terminalReason: "missed-run-skipped",
            triggerSource: "catch-up",
          })
        )
        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "overdue-1",
            lastTerminalReason: "missed-run-skipped",
          })
        )
      })

      it("should execute bounded catch-up runs when runMissedOnStartup is enabled", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const now = new Date()
        const overdueTask: ScheduledTask = {
          id: "overdue-catchup-1",
          name: "Overdue Catch-up Task",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 0,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
            maxMissedRuns: 2,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          nextRunAt: new Date(now.getTime() - 5 * 60000),
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(now.getTime() - 60 * 60000),
          updatedAt: now,
        }

        mockSchedulerDb.getTasksByStatus.mockResolvedValueOnce([overdueTask])

        await (scheduler as unknown as { checkMissedTasks: () => Promise<void> }).checkMissedTasks()

        expect(executor).toHaveBeenCalledTimes(2)

        const catchUpExecutions = mockSchedulerDb.createExecution.mock.calls
          .map(([execution]) => execution)
          .filter((execution) => execution.triggerSource === "catch-up")
        expect(catchUpExecutions).toHaveLength(2)
        expect(catchUpExecutions[0]).toEqual(
          expect.objectContaining({
            scheduledFor: overdueTask.nextRunAt,
          })
        )

        const updatedTaskAfterCatchUp = mockSchedulerDb.updateTask.mock.calls
          .map(([task]) => task)
          .filter((task) => task.id === "overdue-catchup-1")
          .at(-1)
        expect(updatedTaskAfterCatchUp).toEqual(
          expect.objectContaining({
            id: "overdue-catchup-1",
          })
        )
        expect(updatedTaskAfterCatchUp?.nextRunAt?.getTime()).toBeGreaterThan(now.getTime())
      })

      it("should expire overdue one-time task", async () => {
        const overdueOneTimeTask: ScheduledTask = {
          id: "once-overdue-1",
          name: "Overdue Once",
          type: "test",
          trigger: { type: "once", runAt: new Date(Date.now() - 120000) },
          config: {
            maxRetries: 0,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
            maxMissedRuns: 1,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          nextRunAt: new Date(Date.now() - 120000),
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(Date.now() - 60 * 60000),
          updatedAt: new Date(),
        }

        mockSchedulerDb.getTasksByStatus.mockResolvedValueOnce([overdueOneTimeTask])

        await (scheduler as unknown as { checkMissedTasks: () => Promise<void> }).checkMissedTasks()

        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "once-overdue-1",
            status: "expired",
            lastTerminalReason: "once-expired",
          })
        )
      })
    })

    describe("getTaskExecutions", () => {
      it("should return task executions", async () => {
        mockSchedulerDb.getTaskExecutions.mockResolvedValueOnce([])
        const result = await scheduler.getTaskExecutions("task-1")
        expect(Array.isArray(result)).toBe(true)
      })

      it("should respect limit parameter", async () => {
        await scheduler.getTaskExecutions("task-1", 10)
        expect(mockSchedulerDb.getTaskExecutions).toHaveBeenCalledWith("task-1", 10)
      })
    })

    describe("getStatus", () => {
      it("should return scheduler status", () => {
        const status = scheduler.getStatus()
        expect(status).toHaveProperty("initialized")
        expect(status).toHaveProperty("scheduledCount")
        expect(status).toHaveProperty("runningCount")
      })
    })

    describe("triggerEventTask", () => {
      it("should trigger event-based tasks", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const eventTask: ScheduledTask = {
          id: "event-task-1",
          name: "Event Task",
          type: "test",
          trigger: { type: "event", eventType: "test-event" },
          config: {
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: true,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getActiveEventTasks.mockResolvedValueOnce([eventTask])

        await scheduler.triggerEventTask("test-event")

        // Give time for async execution (use advanceTimersByTimeAsync to avoid infinite loop with intervals)
        await jest.advanceTimersByTimeAsync(100)

        expect(executor).toHaveBeenCalled()
      })
    })

    describe("plugin hook dispatches", () => {
      it("should dispatch onScheduledTaskStart when task begins execution", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const task: ScheduledTask = {
          id: "task-hook-1",
          name: "Hook Test",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 0,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: true,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: false },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(task)

        await scheduler.runTaskNow("task-hook-1")

        expect(mockDispatchOnScheduledTaskStart).toHaveBeenCalledWith(
          "task-hook-1",
          expect.any(String)
        )
      })

      it("should dispatch onScheduledTaskComplete on successful execution", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true, output: { result: "done" } })
        registerTaskExecutor("test", executor)

        const task: ScheduledTask = {
          id: "task-hook-2",
          name: "Hook Complete",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 0,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: true,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: false },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(task)

        await scheduler.runTaskNow("task-hook-2")

        expect(mockDispatchOnScheduledTaskComplete).toHaveBeenCalledWith(
          "task-hook-2",
          expect.any(String),
          expect.objectContaining({ success: true })
        )
      })

      it("should dispatch onScheduledTaskError on failed execution", async () => {
        const executor = jest.fn().mockResolvedValue({ success: false, error: "Task failed" })
        registerTaskExecutor("test", executor)

        const task: ScheduledTask = {
          id: "task-hook-3",
          name: "Hook Error",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 0,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: true,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: false },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(task)

        await scheduler.runTaskNow("task-hook-3")

        expect(mockDispatchOnScheduledTaskError).toHaveBeenCalledWith(
          "task-hook-3",
          expect.any(String),
          expect.any(Error)
        )
      })

      it("should dispatch onScheduledTaskError when executor throws", async () => {
        const executor = jest.fn().mockRejectedValue(new Error("Executor crash"))
        registerTaskExecutor("test", executor)

        const task: ScheduledTask = {
          id: "task-hook-4",
          name: "Hook Crash",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 0,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: true,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: false },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(task)

        await scheduler.runTaskNow("task-hook-4")

        expect(mockDispatchOnScheduledTaskError).toHaveBeenCalledWith(
          "task-hook-4",
          expect.any(String),
          expect.any(Error)
        )
      })
    })

    describe("exportTasks", () => {
      it("should export all tasks when no IDs specified", async () => {
        const tasks: ScheduledTask[] = [
          {
            id: "task-exp-1",
            name: "Export Test 1",
            type: "test",
            trigger: { type: "interval", intervalMs: 60000 },
            config: {
              maxRetries: 3,
              retryDelay: 1000,
              timeout: 30000,
              allowConcurrent: false,
              runMissedOnStartup: true,
            },
            notification: { onStart: false, onComplete: false, onError: true },
            status: "active",
            runCount: 0,
            successCount: 0,
            failureCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]
        mockSchedulerDb.getAllTasks.mockResolvedValueOnce(tasks)

        const result = await scheduler.exportTasks()

        expect(result.version).toBe(1)
        expect(result.exportedAt).toBeDefined()
        expect(result.tasks).toHaveLength(1)
        expect(result.tasks[0].id).toBe("task-exp-1")
      })

      it("should export only specified task IDs", async () => {
        const tasks: ScheduledTask[] = [
          {
            id: "task-a",
            name: "A",
            type: "test",
            trigger: { type: "interval", intervalMs: 60000 },
            config: {
              maxRetries: 3,
              retryDelay: 1000,
              timeout: 30000,
              allowConcurrent: false,
              runMissedOnStartup: true,
            },
            notification: { onStart: false, onComplete: false, onError: true },
            status: "active",
            runCount: 0,
            successCount: 0,
            failureCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "task-b",
            name: "B",
            type: "test",
            trigger: { type: "interval", intervalMs: 60000 },
            config: {
              maxRetries: 3,
              retryDelay: 1000,
              timeout: 30000,
              allowConcurrent: false,
              runMissedOnStartup: true,
            },
            notification: { onStart: false, onComplete: false, onError: true },
            status: "active",
            runCount: 0,
            successCount: 0,
            failureCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]
        mockSchedulerDb.getAllTasks.mockResolvedValueOnce(tasks)

        const result = await scheduler.exportTasks(["task-b"])

        expect(result.tasks).toHaveLength(1)
        expect(result.tasks[0].id).toBe("task-b")
      })
    })

    describe("importTasks", () => {
      it("should reject invalid import data", async () => {
        const result = await scheduler.importTasks({
          version: 0,
          tasks: null as unknown as ScheduledTask[],
        })

        expect(result.imported).toBe(0)
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]).toContain("Invalid import format")
      })

      it("should import valid tasks in merge mode", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(null) // no existing task

        const importData = {
          version: 1,
          tasks: [
            {
              id: "import-1",
              name: "Imported Task",
              type: "test",
              trigger: { type: "interval" as const, intervalMs: 60000 },
              config: {
                maxRetries: 3,
                retryDelay: 1000,
                timeout: 30000,
                allowConcurrent: false,
                runMissedOnStartup: true,
              },
              notification: { onStart: false, onComplete: false, onError: true },
              status: "active" as const,
              runCount: 5,
              successCount: 3,
              failureCount: 2,
              createdAt: new Date("2025-01-01"),
              updatedAt: new Date("2025-06-01"),
            },
          ],
        }

        const result = await scheduler.importTasks(
          importData as { version: number; tasks: ScheduledTask[] },
          "merge"
        )

        expect(result.imported).toBe(1)
        expect(result.skipped).toBe(0)
        expect(mockSchedulerDb.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "import-1",
            name: "Imported Task",
            runCount: 0,
            successCount: 0,
            failureCount: 0,
            status: "active",
          })
        )
      })

      it("should skip tasks that already exist in merge mode", async () => {
        const existingTask: ScheduledTask = {
          id: "existing-1",
          name: "Existing",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 30000,
            allowConcurrent: false,
            runMissedOnStartup: true,
          },
          notification: { onStart: false, onComplete: false, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        mockSchedulerDb.getTask.mockResolvedValueOnce(existingTask)

        const importData = {
          version: 1,
          tasks: [existingTask],
        }

        const result = await scheduler.importTasks(importData, "merge")

        expect(result.skipped).toBe(1)
        expect(result.imported).toBe(0)
      })

      it("should skip invalid tasks without name/type/trigger", async () => {
        const importData = {
          version: 1,
          tasks: [{ id: "bad-1" } as unknown as ScheduledTask],
        }

        const result = await scheduler.importTasks(importData)

        expect(result.skipped).toBe(1)
        expect(result.errors).toHaveLength(1)
      })

      it("should report invalid conversational payloads during import", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(null)

        const importData = {
          version: 1,
          tasks: [
            {
              id: "bad-agent-1",
              name: "Bad Agent Task",
              type: "agent" as const,
              trigger: { type: "cron" as const, cronExpression: "0 9 * * *" },
              payload: {},
              config: {
                maxRetries: 0,
                retryDelay: 1000,
                timeout: 30000,
                allowConcurrent: false,
                runMissedOnStartup: true,
              },
              notification: { onStart: false, onComplete: false, onError: true },
              status: "active" as const,
              runCount: 0,
              successCount: 0,
              failureCount: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        }

        const result = await scheduler.importTasks(
          importData as { version: number; tasks: ScheduledTask[] },
          "merge"
        )

        expect(result.imported).toBe(0)
        expect(result.errors[0]).toContain("agent")
      })

      it("should delete all tasks in replace mode before importing", async () => {
        const existingTasks: ScheduledTask[] = [
          {
            id: "old-1",
            name: "Old",
            type: "test",
            trigger: { type: "interval", intervalMs: 60000 },
            config: {
              maxRetries: 3,
              retryDelay: 1000,
              timeout: 30000,
              allowConcurrent: false,
              runMissedOnStartup: true,
            },
            notification: { onStart: false, onComplete: false, onError: true },
            status: "active",
            runCount: 0,
            successCount: 0,
            failureCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]
        mockSchedulerDb.getAllTasks.mockResolvedValueOnce(existingTasks)
        mockSchedulerDb.getTask.mockResolvedValue(null)

        const importData = {
          version: 1,
          tasks: [
            {
              id: "new-1",
              name: "New Task",
              type: "test",
              trigger: { type: "interval" as const, intervalMs: 60000 },
              config: {
                maxRetries: 3,
                retryDelay: 1000,
                timeout: 30000,
                allowConcurrent: false,
                runMissedOnStartup: true,
              },
              notification: { onStart: false, onComplete: false, onError: true },
              status: "active" as const,
              runCount: 0,
              successCount: 0,
              failureCount: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        }

        const result = await scheduler.importTasks(
          importData as { version: number; tasks: ScheduledTask[] },
          "replace"
        )

        expect(mockSchedulerDb.deleteTask).toHaveBeenCalledWith("old-1")
        expect(result.imported).toBe(1)
      })
    })

    describe("timeout behavior", () => {
      it("should not retry after an execution timeout", async () => {
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })

        const slowExecutor = jest.fn().mockImplementation(
          () =>
            new Promise(() => {
              /* never resolves */
            })
        )
        registerTaskExecutor("test", slowExecutor)

        const task = await scheduler.createTask({
          name: "Timeout Test",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            timeout: 100,
            maxRetries: 3,
            retryDelay: 10,
            allowConcurrent: true,
            runMissedOnStartup: false,
          },
        })

        mockSchedulerDb.getTask.mockResolvedValue(task)

        const executionPromise = scheduler.runTaskNow(task.id)
        await jest.advanceTimersByTimeAsync(150)
        const execution = await executionPromise

        expect(execution).not.toBeNull()
        expect(execution!.status).toBe("failed")
        expect(execution!.terminalReason).toBe("execution-timeout")
        expect(slowExecutor).toHaveBeenCalledTimes(1)

        jest.useRealTimers()
      })

      it("should still retry non-timeout failures", async () => {
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })

        const flakyExecutor = jest
          .fn()
          .mockRejectedValueOnce(new Error("transient"))
          .mockResolvedValueOnce({ success: true })
        registerTaskExecutor("test", flakyExecutor)

        const task = await scheduler.createTask({
          name: "Retry Test",
          type: "test",
          trigger: { type: "interval", intervalMs: 60000 },
          config: {
            timeout: 30000,
            maxRetries: 1,
            retryDelay: 10,
            allowConcurrent: true,
            runMissedOnStartup: false,
          },
        })

        mockSchedulerDb.getTask.mockResolvedValue(task)

        await scheduler.runTaskNow(task.id)
        await jest.advanceTimersByTimeAsync(20)

        expect(flakyExecutor).toHaveBeenCalledTimes(2)

        jest.useRealTimers()
      })
    })
  })
})
