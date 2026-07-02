/**
 * @jest-environment jsdom
 */

import {
  getTaskScheduler,
  initTaskScheduler,
  stopTaskScheduler,
  registerTaskExecutor,
  unregisterTaskExecutor,
  createTaskScheduler,
  TaskSchedulerImpl,
} from "./task-scheduler"
import type {
  ScheduledTask,
  CreateScheduledTaskInput,
  SchedulerTimingDriver,
  TaskDueCallback,
} from "@/types/scheduler"

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
    getOverdueActiveTasks: jest.fn().mockResolvedValue([]),
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

jest.mock("@/lib/logging", () => {
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

      it("tags the execution with a caller-supplied triggerSource", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const task: ScheduledTask = {
          id: "task-remote",
          name: "Remote",
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

        await scheduler.runTaskNow("task-remote", { triggerSource: "remote" })

        expect(mockSchedulerDb.createExecution).toHaveBeenCalledWith(
          expect.objectContaining({ triggerSource: "remote" })
        )
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
            terminalReason: "overlap-skipped",
          })
        )

        resolveFirstExecution?.({ success: true })
        await firstExecution
      })
    })

    describe("missed-run reconciliation", () => {
      it("queries schedulerDb.getOverdueActiveTasks instead of fetching all active tasks", async () => {
        mockSchedulerDb.getOverdueActiveTasks.mockResolvedValueOnce([])
        mockSchedulerDb.getTasksByStatus.mockClear()

        await (scheduler as unknown as { checkMissedTasks: () => Promise<void> }).checkMissedTasks()

        expect(mockSchedulerDb.getOverdueActiveTasks).toHaveBeenCalledTimes(1)
        // getTasksByStatus is still used elsewhere (init, stats) but must not
        // be the source of checkMissedTasks's task list anymore.
        expect(mockSchedulerDb.getTasksByStatus).not.toHaveBeenCalled()
      })

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

        mockSchedulerDb.getOverdueActiveTasks.mockResolvedValueOnce([overdueTask])

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

        mockSchedulerDb.getOverdueActiveTasks.mockResolvedValueOnce([overdueTask])

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

        mockSchedulerDb.getOverdueActiveTasks.mockResolvedValueOnce([overdueOneTimeTask])

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

  describe("timing driver injection (Rust-daemon mode)", () => {
    function makeMockDriver() {
      let dueCb: TaskDueCallback | null = null
      const driver: SchedulerTimingDriver & { fire: TaskDueCallback } = {
        supportsLeaderElection: false,
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
        onDue: jest.fn((cb: TaskDueCallback) => {
          dueCb = cb
        }),
        arm: jest.fn(),
        disarm: jest.fn(),
        fire: (taskId, firedAtMs) => dueCb?.(taskId, firedAtMs),
      }
      return driver
    }

    it("starts the injected driver and skips leader election", async () => {
      const driver = makeMockDriver()
      const sched = createTaskScheduler(driver)
      await sched.initialize()

      expect(driver.start).toHaveBeenCalled()
      expect(driver.onDue).toHaveBeenCalled()
      // No leader election → active tasks are armed directly on init.
      expect(mockSchedulerDb.getTasksByStatus).toHaveBeenCalledWith("active")
      sched.stop()
      expect(driver.stop).toHaveBeenCalled()
    })

    it("arms newly-created tasks through the driver", async () => {
      const driver = makeMockDriver()
      const sched = createTaskScheduler(driver)
      await sched.initialize()

      const task = await sched.createTask({
        name: "Armed Task",
        type: "test",
        trigger: { type: "interval", intervalMs: 60000 },
      })

      expect(driver.arm).toHaveBeenCalledWith(task.id, expect.any(Number))
      sched.stop()
    })

    it("executes a task when the driver reports it due, using the armed slot", async () => {
      const executor = jest.fn().mockResolvedValue({ success: true })
      registerTaskExecutor("test", executor)

      const driver = makeMockDriver()
      const sched = createTaskScheduler(driver)
      await sched.initialize()

      const task: ScheduledTask = {
        id: "due-task-1",
        name: "Due Task",
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
      mockSchedulerDb.getTask.mockResolvedValue(task)

      const slot = Date.now()
      driver.fire("due-task-1", slot)
      await jest.advanceTimersByTimeAsync(10)

      expect(executor).toHaveBeenCalled()
      expect(mockSchedulerDb.createExecution).toHaveBeenCalledWith(
        expect.objectContaining({ triggerSource: "schedule", scheduledFor: new Date(slot) })
      )
      sched.stop()
    })

    it("ignores due events for missing or non-active tasks", async () => {
      const executor = jest.fn().mockResolvedValue({ success: true })
      registerTaskExecutor("test", executor)

      const driver = makeMockDriver()
      const sched = createTaskScheduler(driver)
      await sched.initialize()

      mockSchedulerDb.getTask.mockResolvedValueOnce(null)
      driver.fire("ghost", Date.now())
      await jest.advanceTimersByTimeAsync(10)

      expect(executor).not.toHaveBeenCalled()
      sched.stop()
    })
  })

  describe("runtime semantics upgrades", () => {
    function makeMockDriver() {
      let dueCb: TaskDueCallback | null = null
      const driver: SchedulerTimingDriver & { fire: TaskDueCallback } = {
        supportsLeaderElection: false,
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
        onDue: jest.fn((cb: TaskDueCallback) => {
          dueCb = cb
        }),
        arm: jest.fn(),
        disarm: jest.fn(),
        fire: (taskId, firedAtMs) => dueCb?.(taskId, firedAtMs),
      }
      return driver
    }

    function makePolicyTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
      return {
        id: "policy-task",
        name: "Policy Task",
        type: "test",
        trigger: { type: "interval", intervalMs: 60000 },
        config: {
          maxRetries: 0,
          retryDelay: 1000,
          timeout: 30000,
          runMissedOnStartup: false,
          overlapPolicy: "skip",
        },
        notification: { onStart: false, onComplete: false, onError: false },
        status: "active",
        runCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      }
    }

    /** Executor whose first call blocks until released; later calls succeed. */
    function makeBlockingExecutor() {
      let release: ((result: { success: boolean }) => void) | undefined
      let calls = 0
      const executor = jest.fn().mockImplementation(() => {
        calls += 1
        if (calls === 1) {
          return new Promise<{ success: boolean }>((resolve) => {
            release = resolve
          })
        }
        return Promise.resolve({ success: true })
      })
      return { executor, release: () => release?.({ success: true }) }
    }

    let scheduler: TaskSchedulerImpl

    beforeEach(() => {
      scheduler = createTaskScheduler()
    })

    describe("overlap policies", () => {
      it("allow: runs concurrently with a running execution", async () => {
        const { executor, release } = makeBlockingExecutor()
        registerTaskExecutor("test", executor)
        const task = makePolicyTask({
          id: "allow-task",
          config: { ...makePolicyTask().config, overlapPolicy: "allow" },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        const first = scheduler.runTaskNow(task.id)
        await Promise.resolve()
        const second = await scheduler.runTaskNow(task.id)

        expect(second?.status).toBe("completed")
        expect(executor).toHaveBeenCalledTimes(2)

        release()
        const firstExec = await first
        expect(firstExec?.status).toBe("completed")
      })

      it("queue-one: buffers the start and drains it after completion", async () => {
        const { executor, release } = makeBlockingExecutor()
        registerTaskExecutor("test", executor)
        const task = makePolicyTask({
          id: "queue-one-task",
          config: { ...makePolicyTask().config, overlapPolicy: "queue-one" },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        const first = scheduler.runTaskNow(task.id)
        await Promise.resolve()
        const second = await scheduler.runTaskNow(task.id)

        // Buffered: placeholder only, no persisted execution row for it yet.
        expect(second?.status).toBe("pending")
        expect(executor).toHaveBeenCalledTimes(1)

        release()
        await first
        await jest.advanceTimersByTimeAsync(10)

        expect(executor).toHaveBeenCalledTimes(2)
      })

      it("queue-one: a newer start displaces the buffered one as overlap-skipped", async () => {
        const { executor, release } = makeBlockingExecutor()
        registerTaskExecutor("test", executor)
        const task = makePolicyTask({
          id: "queue-one-displace",
          config: { ...makePolicyTask().config, overlapPolicy: "queue-one" },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        const first = scheduler.runTaskNow(task.id)
        await Promise.resolve()
        await scheduler.runTaskNow(task.id)
        await scheduler.runTaskNow(task.id)

        // The displaced buffered start became a persisted skipped row.
        expect(mockSchedulerDb.createExecution).toHaveBeenCalledWith(
          expect.objectContaining({ status: "skipped", terminalReason: "overlap-skipped" })
        )

        release()
        await first
        await jest.advanceTimersByTimeAsync(10)

        // Running + exactly one drained start (newest wins).
        expect(executor).toHaveBeenCalledTimes(2)
      })

      it("queue-all: drops starts beyond maxQueueSize as overlap-skipped", async () => {
        const { executor, release } = makeBlockingExecutor()
        registerTaskExecutor("test", executor)
        const task = makePolicyTask({
          id: "queue-all-task",
          config: { ...makePolicyTask().config, overlapPolicy: "queue-all", maxQueueSize: 1 },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        const first = scheduler.runTaskNow(task.id)
        await Promise.resolve()
        const buffered = await scheduler.runTaskNow(task.id)
        const overflow = await scheduler.runTaskNow(task.id)

        expect(buffered?.status).toBe("pending")
        expect(overflow?.status).toBe("skipped")
        expect(overflow?.terminalReason).toBe("overlap-skipped")

        release()
        await first
        await jest.advanceTimersByTimeAsync(10)

        expect(executor).toHaveBeenCalledTimes(2)
      })

      it("cancel-previous: aborts the running execution and starts the new one", async () => {
        const { executor } = makeBlockingExecutor()
        registerTaskExecutor("test", executor)
        const task = makePolicyTask({
          id: "cancel-prev-task",
          config: { ...makePolicyTask().config, overlapPolicy: "cancel-previous", maxRetries: 2 },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        const first = scheduler.runTaskNow(task.id)
        await Promise.resolve()
        const second = await scheduler.runTaskNow(task.id)
        const firstExec = await first

        expect(firstExec?.status).toBe("cancelled")
        expect(firstExec?.terminalReason).toBe("overlap-cancelled")
        expect(second?.status).toBe("completed")
        // Cancelled runs are terminal: no retry of the first execution.
        await jest.advanceTimersByTimeAsync(60_000)
        expect(executor).toHaveBeenCalledTimes(2)
      })
    })

    describe("lifecycle limits", () => {
      it("expires a task whose endAt passed instead of executing it", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)
        const driver = makeMockDriver()
        const sched = createTaskScheduler(driver)
        await sched.initialize()

        const task = makePolicyTask({
          id: "ended-task",
          endAt: new Date(Date.now() - 1000),
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        driver.fire("ended-task", Date.now())
        await jest.advanceTimersByTimeAsync(10)

        expect(executor).not.toHaveBeenCalled()
        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({ status: "expired", lastTerminalReason: "ended" })
        )
        expect(driver.disarm).toHaveBeenCalledWith("ended-task")
        sched.stop()
      })

      it("expires a task that already consumed its maxRuns budget", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)
        const driver = makeMockDriver()
        const sched = createTaskScheduler(driver)
        await sched.initialize()

        const task = makePolicyTask({
          id: "max-runs-task",
          runCount: 3,
          config: { ...makePolicyTask().config, maxRuns: 3 },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        driver.fire("max-runs-task", Date.now())
        await jest.advanceTimersByTimeAsync(10)

        expect(executor).not.toHaveBeenCalled()
        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({ status: "expired", lastTerminalReason: "max-runs-reached" })
        )
        sched.stop()
      })

      it("expires after the run that consumes the final maxRuns slot", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const task = makePolicyTask({
          id: "final-run-task",
          runCount: 0,
          config: { ...makePolicyTask().config, maxRuns: 1 },
        })
        // runTaskNow + updateTaskStats see runCount 0; the post-run re-fetch
        // in updateNextRunTime sees the consumed budget.
        mockSchedulerDb.getTask
          .mockResolvedValueOnce(task)
          .mockResolvedValueOnce(task)
          .mockResolvedValue({ ...task, runCount: 1 })

        const execution = await scheduler.runTaskNow(task.id)

        expect(execution?.status).toBe("completed")
        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({ status: "expired", lastTerminalReason: "max-runs-reached" })
        )
      })
    })

    describe("pause-on-failure", () => {
      it("auto-pauses after the consecutive-failure threshold and notifies", async () => {
        const executor = jest.fn().mockResolvedValue({ success: false, error: "boom" })
        registerTaskExecutor("test", executor)
        const { notifyTaskEvent } = jest.requireMock("./notification-integration") as {
          notifyTaskEvent: jest.Mock
        }

        const task = makePolicyTask({
          id: "pause-task",
          consecutiveFailures: 1,
          config: { ...makePolicyTask().config, pauseAfterConsecutiveFailures: 2 },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        await scheduler.runTaskNow(task.id)

        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "paused",
            lastTerminalReason: "auto-paused",
            consecutiveFailures: 2,
          })
        )
        expect(notifyTaskEvent).toHaveBeenCalledWith(
          expect.objectContaining({ id: "pause-task" }),
          expect.anything(),
          "auto-paused"
        )
      })

      it("stays active below the threshold and increments the counter", async () => {
        const executor = jest.fn().mockResolvedValue({ success: false, error: "boom" })
        registerTaskExecutor("test", executor)

        const task = makePolicyTask({
          id: "below-threshold",
          config: { ...makePolicyTask().config, pauseAfterConsecutiveFailures: 3 },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        await scheduler.runTaskNow(task.id)

        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({ consecutiveFailures: 1 })
        )
        expect(mockSchedulerDb.updateTask).not.toHaveBeenCalledWith(
          expect.objectContaining({ status: "paused" })
        )
      })

      it("resets the consecutive counter on success", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const task = makePolicyTask({
          id: "reset-task",
          consecutiveFailures: 2,
          config: { ...makePolicyTask().config, pauseAfterConsecutiveFailures: 3 },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        await scheduler.runTaskNow(task.id)

        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({ consecutiveFailures: 0 })
        )
      })
    })

    describe("forward chains", () => {
      it("fires onSuccessTaskIds after a successful run", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const target = makePolicyTask({ id: "success-target" })
        const source = makePolicyTask({
          id: "chain-source",
          onSuccessTaskIds: ["success-target"],
          onFailureTaskIds: ["failure-target"],
        })
        mockSchedulerDb.getTask.mockImplementation(async (id: string) =>
          id === "chain-source" ? source : id === "success-target" ? target : null
        )

        await scheduler.runTaskNow(source.id)
        await jest.advanceTimersByTimeAsync(10)

        expect(executor).toHaveBeenCalledWith(
          expect.objectContaining({ id: "success-target" }),
          expect.anything(),
          expect.anything()
        )
        // The failure branch must not fire on success.
        expect(executor).not.toHaveBeenCalledWith(
          expect.objectContaining({ id: "failure-target" }),
          expect.anything(),
          expect.anything()
        )
      })

      it("fires onFailureTaskIds only on terminal failure", async () => {
        const executor = jest.fn().mockImplementation(async (task: ScheduledTask) => {
          if (task.id === "fail-source") return { success: false, error: "boom" }
          return { success: true }
        })
        registerTaskExecutor("test", executor)

        const cleanup = makePolicyTask({ id: "cleanup-target" })
        const source = makePolicyTask({
          id: "fail-source",
          onSuccessTaskIds: ["success-target"],
          onFailureTaskIds: ["cleanup-target"],
        })
        mockSchedulerDb.getTask.mockImplementation(async (id: string) =>
          id === "fail-source" ? source : id === "cleanup-target" ? cleanup : null
        )

        await scheduler.runTaskNow(source.id)
        await jest.advanceTimersByTimeAsync(10)

        expect(executor).toHaveBeenCalledWith(
          expect.objectContaining({ id: "cleanup-target" }),
          expect.anything(),
          expect.anything()
        )
        expect(executor).not.toHaveBeenCalledWith(
          expect.objectContaining({ id: "success-target" }),
          expect.anything(),
          expect.anything()
        )
      })

      it("waits for the retry chain before firing the failure chain", async () => {
        const executor = jest.fn().mockImplementation(async (task: ScheduledTask) => {
          if (task.id === "retry-source") return { success: false, error: "boom" }
          return { success: true }
        })
        registerTaskExecutor("test", executor)

        const cleanup = makePolicyTask({ id: "retry-cleanup" })
        const source = makePolicyTask({
          id: "retry-source",
          onFailureTaskIds: ["retry-cleanup"],
          config: { ...makePolicyTask().config, maxRetries: 1, retryDelay: 1000 },
        })
        mockSchedulerDb.getTask.mockImplementation(async (id: string) =>
          id === "retry-source" ? source : id === "retry-cleanup" ? cleanup : null
        )

        await scheduler.runTaskNow(source.id)
        // Retry pending — failure chain must not fire yet.
        expect(executor).not.toHaveBeenCalledWith(
          expect.objectContaining({ id: "retry-cleanup" }),
          expect.anything(),
          expect.anything()
        )

        await jest.advanceTimersByTimeAsync(5_000)

        expect(executor).toHaveBeenCalledWith(
          expect.objectContaining({ id: "retry-cleanup" }),
          expect.anything(),
          expect.anything()
        )
        // Source ran twice (original + one retry), cleanup once.
        const cleanupCalls = executor.mock.calls.filter(
          (c) => (c[0] as ScheduledTask).id === "retry-cleanup"
        )
        expect(cleanupCalls).toHaveLength(1)
      })

      it("skips missing or non-active forward targets", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const pausedTarget = makePolicyTask({ id: "paused-target", status: "paused" })
        const source = makePolicyTask({
          id: "skip-source",
          onSuccessTaskIds: ["ghost-target", "paused-target"],
        })
        mockSchedulerDb.getTask.mockImplementation(async (id: string) =>
          id === "skip-source" ? source : id === "paused-target" ? pausedTarget : null
        )

        await scheduler.runTaskNow(source.id)
        await jest.advanceTimersByTimeAsync(10)

        expect(executor).toHaveBeenCalledTimes(1)
        expect(executor).toHaveBeenCalledWith(
          expect.objectContaining({ id: "skip-source" }),
          expect.anything(),
          expect.anything()
        )
      })
    })

    describe("backfill", () => {
      it("runs each slot sequentially with backfill provenance, without touching nextRunAt", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const createdAt = new Date(Date.now() - 60 * 60_000)
        const task = makePolicyTask({
          id: "backfill-task",
          trigger: { type: "interval", intervalMs: 10 * 60_000 }, // 10 min
          createdAt,
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        const start = new Date(createdAt.getTime() + 10 * 60_000)
        const end = new Date(createdAt.getTime() + 30 * 60_000)
        const executions = await scheduler.backfillTask(task.id, { start, end })

        expect(executions).toHaveLength(3)
        expect(executor).toHaveBeenCalledTimes(3)

        const backfillRows = mockSchedulerDb.createExecution.mock.calls
          .map(([execution]) => execution)
          .filter((execution) => execution.triggerSource === "backfill")
        expect(backfillRows).toHaveLength(3)
        // Oldest-first slot order.
        expect(backfillRows.map((e) => e.scheduledFor?.getTime())).toEqual([
          createdAt.getTime() + 10 * 60_000,
          createdAt.getTime() + 20 * 60_000,
          createdAt.getTime() + 30 * 60_000,
        ])
      })

      it("rejects backfill for non-recurring triggers", async () => {
        const task = makePolicyTask({
          id: "once-backfill",
          trigger: { type: "once", runAt: new Date(Date.now() + 60_000) },
        })
        mockSchedulerDb.getTask.mockResolvedValue(task)

        await expect(
          scheduler.backfillTask(task.id, { start: new Date(0), end: new Date() })
        ).rejects.toMatchObject({ code: "INVALID_TRIGGER" })
      })

      it("rejects backfill for unknown tasks", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(null)
        await expect(
          scheduler.backfillTask("ghost", { start: new Date(0), end: new Date() })
        ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" })
      })
    })

    describe("catch-up window", () => {
      it("skips missed slots older than catchupWindowMs with their own reason", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const now = Date.now()
        const overdueTask = makePolicyTask({
          id: "windowed-task",
          trigger: { type: "interval", intervalMs: 60_000 },
          // Two missed slots: 5min ago (outside window) and 4min ago (outside),
          // window 2min → both skipped as catchup-window-expired.
          nextRunAt: new Date(now - 5 * 60_000),
          createdAt: new Date(now - 60 * 60_000),
          config: {
            ...makePolicyTask().config,
            runMissedOnStartup: true,
            maxMissedRuns: 2,
            catchupWindowMs: 2 * 60_000,
          },
        })
        mockSchedulerDb.getOverdueActiveTasks.mockResolvedValueOnce([overdueTask])

        await (scheduler as unknown as { checkMissedTasks: () => Promise<void> }).checkMissedTasks()

        expect(executor).not.toHaveBeenCalled()
        const skipped = mockSchedulerDb.createExecution.mock.calls
          .map(([execution]) => execution)
          .filter((execution) => execution.terminalReason === "catchup-window-expired")
        expect(skipped).toHaveLength(2)
        expect(mockSchedulerDb.updateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "windowed-task",
            lastTerminalReason: "catchup-window-expired",
          })
        )
      })

      it("runs fresh missed slots and skips only the stale ones", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const now = Date.now()
        const overdueTask = makePolicyTask({
          id: "partial-window-task",
          trigger: { type: "interval", intervalMs: 60_000 },
          // Missed slots at -3min (stale) and -2min (fresh) with a 2.5min window.
          nextRunAt: new Date(now - 3 * 60_000),
          createdAt: new Date(now - 60 * 60_000),
          config: {
            ...makePolicyTask().config,
            runMissedOnStartup: true,
            maxMissedRuns: 2,
            catchupWindowMs: 2.5 * 60_000,
          },
        })
        mockSchedulerDb.getOverdueActiveTasks.mockResolvedValueOnce([overdueTask])
        mockSchedulerDb.getTask.mockResolvedValue(overdueTask)

        await (scheduler as unknown as { checkMissedTasks: () => Promise<void> }).checkMissedTasks()

        expect(executor).toHaveBeenCalledTimes(1)
        const skipped = mockSchedulerDb.createExecution.mock.calls
          .map(([execution]) => execution)
          .filter((execution) => execution.terminalReason === "catchup-window-expired")
        expect(skipped).toHaveLength(1)
        expect(skipped[0].scheduledFor?.getTime()).toBe(now - 3 * 60_000)
      })

      it("keeps today's behavior when no window is configured", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const now = Date.now()
        const overdueTask = makePolicyTask({
          id: "no-window-task",
          trigger: { type: "interval", intervalMs: 60_000 },
          nextRunAt: new Date(now - 5 * 60_000),
          createdAt: new Date(now - 60 * 60_000),
          config: {
            ...makePolicyTask().config,
            runMissedOnStartup: true,
            maxMissedRuns: 2,
          },
        })
        mockSchedulerDb.getOverdueActiveTasks.mockResolvedValueOnce([overdueTask])
        mockSchedulerDb.getTask.mockResolvedValue(overdueTask)

        await (scheduler as unknown as { checkMissedTasks: () => Promise<void> }).checkMissedTasks()

        expect(executor).toHaveBeenCalledTimes(2)
      })
    })

    describe("scheduling jitter", () => {
      it("arms with jitter but keeps the canonical slot in scheduledFor", async () => {
        const executor = jest.fn().mockResolvedValue({ success: true })
        registerTaskExecutor("test", executor)

        const driver = makeMockDriver()
        // rng pinned to ~1 → jitter is the full jitterMs.
        const sched = createTaskScheduler(driver, { rng: () => 0.999999 })
        await sched.initialize()

        const task = await sched.createTask({
          name: "Jittered Task",
          type: "test",
          trigger: { type: "interval", intervalMs: 60_000, jitterMs: 5_000 },
        })

        const canonicalMs = task.nextRunAt!.getTime()
        expect(driver.arm).toHaveBeenCalledWith(task.id, canonicalMs + 5_000)

        // When the (jittered) fire arrives, the canonical slot is preserved.
        mockSchedulerDb.getTask.mockResolvedValue(task)
        driver.fire(task.id, canonicalMs + 5_000)
        await jest.advanceTimersByTimeAsync(10)

        expect(mockSchedulerDb.createExecution).toHaveBeenCalledWith(
          expect.objectContaining({ scheduledFor: new Date(canonicalMs) })
        )
        sched.stop()
      })

      it("arms at the canonical time when jitter is unset", async () => {
        const driver = makeMockDriver()
        const sched = createTaskScheduler(driver, { rng: () => 0.999999 })
        await sched.initialize()

        const task = await sched.createTask({
          name: "Unjittered Task",
          type: "test",
          trigger: { type: "interval", intervalMs: 60_000 },
        })

        expect(driver.arm).toHaveBeenCalledWith(task.id, task.nextRunAt!.getTime())
        sched.stop()
      })
    })
  })
})
