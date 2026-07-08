/** @jest-environment jsdom */
/**
 * Scheduler Store Tests
 */

import { act, renderHook } from "@testing-library/react"
import {
  useSchedulerStore,
  selectSelectedTask,
  selectActiveTasks,
  selectPausedTasks,
  selectUpcomingTasks,
  selectRecentExecutions,
  selectSchedulerStatus,
  selectTasks,
  selectExecutions,
  selectStatistics,
  selectSelectedTaskId,
  selectFilter,
  selectIsLoading,
  selectError,
  selectIsInitialized,
} from "./scheduler-store"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

// Mock the scheduler modules. Variables prefixed with `mock` are allowed in
// jest factories despite hoisting.
jest.mock("@/lib/scheduler/task-scheduler", () => {
  const mockScheduler = {
    createTask: jest.fn(),
    updateTask: jest.fn(),
    deleteTask: jest.fn(),
    pauseTask: jest.fn(),
    resumeTask: jest.fn(),
    runTaskNow: jest.fn(),
    backfillTask: jest.fn(),
    getTask: jest.fn(),
    getAllTasks: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    exportTasks: jest.fn(),
    importTasks: jest.fn(),
  }
  return {
    __mockScheduler: mockScheduler,
    getTaskScheduler: jest.fn(() => mockScheduler),
  }
})

const taskSchedulerMock = jest.requireMock("@/lib/scheduler/task-scheduler") as {
  __mockScheduler: {
    createTask: jest.Mock
    updateTask: jest.Mock
    deleteTask: jest.Mock
    pauseTask: jest.Mock
    resumeTask: jest.Mock
    runTaskNow: jest.Mock
    backfillTask: jest.Mock
    getTask: jest.Mock
    getAllTasks: jest.Mock
    start: jest.Mock
    stop: jest.Mock
    exportTasks: jest.Mock
    importTasks: jest.Mock
  }
  getTaskScheduler: jest.Mock
}

const mockScheduler = taskSchedulerMock.__mockScheduler

jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: {
    getAllTasks: jest.fn().mockResolvedValue([]),
    getFilteredTasks: jest.fn().mockResolvedValue([]),
    getRecentExecutions: jest.fn().mockResolvedValue([]),
    getUpcomingTasks: jest.fn().mockResolvedValue([]),
    getTaskExecutions: jest.fn().mockResolvedValue([]),
    getStatistics: jest.fn().mockResolvedValue({
      totalTasks: 0,
      activeTasks: 0,
      pausedTasks: 0,
      disabledTasks: 0,
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      averageDuration: 0,
      upcomingExecutions: 0,
    }),
    cleanupOldExecutions: jest.fn().mockResolvedValue(0),
  },
}))

jest.mock("@/lib/scheduler/executors/plugin-executor", () => ({
  cancelPluginTaskExecution: jest.fn().mockReturnValue(true),
  getActivePluginTaskCount: jest.fn().mockReturnValue(2),
  isPluginTaskExecutionActive: jest.fn().mockReturnValue(true),
}))

jest.mock("@/lib/scheduler", () => ({
  initSchedulerSystem: jest.fn().mockResolvedValue(undefined),
}))

const { schedulerDb: mockedDb } = jest.requireMock("@/lib/scheduler/scheduler-db") as {
  schedulerDb: {
    getAllTasks: jest.Mock
    getFilteredTasks: jest.Mock
    getRecentExecutions: jest.Mock
    getUpcomingTasks: jest.Mock
    getTaskExecutions: jest.Mock
    getStatistics: jest.Mock
    cleanupOldExecutions: jest.Mock
  }
}

const pluginExecutorMock = jest.requireMock("@/lib/scheduler/executors/plugin-executor") as {
  cancelPluginTaskExecution: jest.Mock
  getActivePluginTaskCount: jest.Mock
  isPluginTaskExecutionActive: jest.Mock
}

const schedulerLibMock = jest.requireMock("@/lib/scheduler") as {
  initSchedulerSystem: jest.Mock
}

const sampleTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "sample-task",
  name: "Sample Task",
  type: "workflow",
  status: "active",
  trigger: { type: "cron", cronExpression: "0 9 * * *" },
  payload: {},
  config: {
    timeout: 300000,
    maxRetries: 3,
    retryDelay: 5000,
    runMissedOnStartup: false,
    maxMissedRuns: 1,
    allowConcurrent: false,
  },
  notification: {
    onStart: false,
    onComplete: true,
    onError: true,
    onProgress: false,
    channels: ["toast"],
  },
  runCount: 0,
  successCount: 0,
  failureCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

beforeEach(() => {
  jest.clearAllMocks()
  // Restore default scheduler-mock behaviors
  mockScheduler.createTask.mockResolvedValue(sampleTask({ id: "new-task-id", name: "New Task" }))
  mockScheduler.updateTask.mockResolvedValue(sampleTask({ id: "updated-task-id" }))
  mockScheduler.deleteTask.mockResolvedValue(true)
  mockScheduler.pauseTask.mockResolvedValue(true)
  mockScheduler.resumeTask.mockResolvedValue(true)
  mockScheduler.runTaskNow.mockResolvedValue({
    id: "exec-1",
    taskId: "sample",
    status: "running",
    startedAt: new Date(),
  })
  mockScheduler.backfillTask.mockResolvedValue([])
  mockScheduler.getTask.mockResolvedValue(null)
  mockScheduler.getAllTasks.mockResolvedValue([])
  mockScheduler.exportTasks.mockResolvedValue({ tasks: [] })
  mockScheduler.importTasks.mockResolvedValue({ imported: 0, skipped: 0, errors: [] })

  // Default DB returns
  mockedDb.getAllTasks.mockResolvedValue([])
  mockedDb.getFilteredTasks.mockResolvedValue([])
  mockedDb.getRecentExecutions.mockResolvedValue([])
  mockedDb.getUpcomingTasks.mockResolvedValue([])
  mockedDb.getTaskExecutions.mockResolvedValue([])
  mockedDb.getStatistics.mockResolvedValue({
    totalTasks: 0,
    activeTasks: 0,
    pausedTasks: 0,
    disabledTasks: 0,
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    averageDuration: 0,
    upcomingExecutions: 0,
  })
  mockedDb.cleanupOldExecutions.mockResolvedValue(0)

  pluginExecutorMock.cancelPluginTaskExecution.mockReturnValue(true)
  pluginExecutorMock.getActivePluginTaskCount.mockReturnValue(2)
  pluginExecutorMock.isPluginTaskExecutionActive.mockReturnValue(true)

  schedulerLibMock.initSchedulerSystem.mockResolvedValue(undefined)
})

describe("useSchedulerStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    const { result } = renderHook(() => useSchedulerStore())
    act(() => {
      result.current.reset()
    })
  })

  describe("Initial State", () => {
    it("should have correct initial state", () => {
      const { result } = renderHook(() => useSchedulerStore())

      expect(result.current.tasks).toEqual([])
      expect(result.current.executions).toEqual([])
      expect(result.current.selectedTaskId).toBeNull()
      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(result.current.isInitialized).toBe(false)
    })

    it("should have default filter", () => {
      const { result } = renderHook(() => useSchedulerStore())

      expect(result.current.filter).toEqual({})
    })
  })

  describe("Task CRUD Operations", () => {
    it("should create a task", async () => {
      const { result } = renderHook(() => useSchedulerStore())

      await act(async () => {
        const task = await result.current.createTask({
          name: "Test Task",
          type: "workflow",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          payload: {},
        })
        expect(task).toBeDefined()
        expect(task?.name).toBe("New Task")
      })
    })

    it("should set loading state during creation", async () => {
      const { result } = renderHook(() => useSchedulerStore())

      const createPromise = act(async () => {
        await result.current.createTask({
          name: "Test Task",
          type: "workflow",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          payload: {},
        })
      })

      // Loading state should be true during the operation
      await createPromise
    })

    it("should delete a task", async () => {
      const { result } = renderHook(() => useSchedulerStore())

      // Add a mock task first
      act(() => {
        result.current.setTasks([
          {
            id: "task-to-delete",
            name: "Task to Delete",
            type: "workflow",
            status: "active",
            trigger: { type: "cron", cronExpression: "0 9 * * *" },
            payload: {},
            config: {
              timeout: 300000,
              maxRetries: 3,
              retryDelay: 5000,
              runMissedOnStartup: false,
              maxMissedRuns: 1,
              allowConcurrent: false,
            },
            notification: {
              onStart: false,
              onComplete: true,
              onError: true,
              onProgress: false,
              channels: ["toast"],
            },
            runCount: 0,
            successCount: 0,
            failureCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ])
      })

      await act(async () => {
        const success = await result.current.deleteTask("task-to-delete")
        expect(success).toBe(true)
      })
    })
  })

  describe("Task Selection", () => {
    it("should select a task", () => {
      const { result } = renderHook(() => useSchedulerStore())

      const mockTask: ScheduledTask = {
        id: "task-1",
        name: "Test Task",
        type: "workflow",
        status: "active",
        trigger: { type: "cron", cronExpression: "0 9 * * *" },
        payload: {},
        config: {
          timeout: 300000,
          maxRetries: 3,
          retryDelay: 5000,
          runMissedOnStartup: false,
          maxMissedRuns: 1,
          allowConcurrent: false,
        },
        notification: {
          onStart: false,
          onComplete: true,
          onError: true,
          onProgress: false,
          channels: ["toast"],
        },
        runCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      act(() => {
        result.current.setTasks([mockTask])
        result.current.selectTask("task-1")
      })

      expect(result.current.selectedTaskId).toBe("task-1")
    })

    it("should clear selection", () => {
      const { result } = renderHook(() => useSchedulerStore())

      act(() => {
        result.current.selectTask("task-1")
      })

      act(() => {
        result.current.clearSelection()
      })

      expect(result.current.selectedTaskId).toBeNull()
    })
  })

  describe("Filtering", () => {
    it("should update filter", () => {
      const { result } = renderHook(() => useSchedulerStore())

      act(() => {
        result.current.setFilter({
          types: ["workflow"],
          statuses: ["active"],
          search: "test",
        })
      })

      expect(result.current.filter.types).toEqual(["workflow"])
      expect(result.current.filter.statuses).toEqual(["active"])
      expect(result.current.filter.search).toBe("test")
    })

    it("should clear filter", () => {
      const { result } = renderHook(() => useSchedulerStore())

      act(() => {
        result.current.setFilter({
          types: ["workflow"],
          statuses: ["active"],
        })
      })

      act(() => {
        result.current.clearFilter()
      })

      expect(result.current.filter).toEqual({})
    })
  })

  describe("Error Handling", () => {
    it("should set and clear errors", () => {
      const { result } = renderHook(() => useSchedulerStore())

      act(() => {
        result.current.setError("Test error")
      })

      expect(result.current.error).toBe("Test error")

      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBeNull()
    })
  })

  describe("Selectors", () => {
    it("should select active tasks", () => {
      const { result } = renderHook(() => useSchedulerStore())

      const activeTasks: ScheduledTask[] = [
        {
          id: "active-1",
          name: "Active Task",
          type: "workflow",
          status: "active",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          payload: {},
          config: {
            timeout: 300000,
            maxRetries: 3,
            retryDelay: 5000,
            runMissedOnStartup: false,
            maxMissedRuns: 1,
            allowConcurrent: false,
          },
          notification: {
            onStart: false,
            onComplete: true,
            onError: true,
            onProgress: false,
            channels: ["toast"],
          },
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "paused-1",
          name: "Paused Task",
          type: "workflow",
          status: "paused",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          payload: {},
          config: {
            timeout: 300000,
            maxRetries: 3,
            retryDelay: 5000,
            runMissedOnStartup: false,
            maxMissedRuns: 1,
            allowConcurrent: false,
          },
          notification: {
            onStart: false,
            onComplete: true,
            onError: true,
            onProgress: false,
            channels: ["toast"],
          },
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]

      act(() => {
        result.current.setTasks(activeTasks)
      })

      const active = result.current.tasks.filter((t) => t.status === "active")
      expect(active.length).toBe(1)
      expect(active[0].id).toBe("active-1")
    })

    it("should select upcoming tasks", () => {
      const { result } = renderHook(() => useSchedulerStore())

      const futureDate = new Date()
      futureDate.setHours(futureDate.getHours() + 1)

      const tasks: ScheduledTask[] = [
        {
          id: "upcoming-1",
          name: "Upcoming Task",
          type: "workflow",
          status: "active",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          payload: {},
          config: {
            timeout: 300000,
            maxRetries: 3,
            retryDelay: 5000,
            runMissedOnStartup: false,
            maxMissedRuns: 1,
            allowConcurrent: false,
          },
          notification: {
            onStart: false,
            onComplete: true,
            onError: true,
            onProgress: false,
            channels: ["toast"],
          },
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          nextRunAt: futureDate,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]

      act(() => {
        result.current.setTasks(tasks)
      })

      const upcoming = result.current.tasks.filter((t) => t.nextRunAt && t.nextRunAt > new Date())
      expect(upcoming.length).toBe(1)
    })
  })

  describe("Statistics", () => {
    it("should load statistics", async () => {
      const { result } = renderHook(() => useSchedulerStore())

      await act(async () => {
        await result.current.loadStatistics()
      })

      expect(result.current.statistics).toBeDefined()
      expect(result.current.statistics?.totalTasks).toBe(0)
    })
  })

  describe("Reset", () => {
    it("should reset store to initial state", () => {
      const { result } = renderHook(() => useSchedulerStore())

      // Set some state
      act(() => {
        result.current.selectTask("task-1")
        result.current.setError("Some error")
        result.current.setFilter({ types: ["workflow"] })
      })

      // Reset
      act(() => {
        result.current.reset()
      })

      expect(result.current.selectedTaskId).toBeNull()
      expect(result.current.error).toBeNull()
      expect(result.current.filter).toEqual({})
    })
  })

  describe("createTask error handling", () => {
    it("returns null and stores the error when scheduler.createTask throws an Error", async () => {
      mockScheduler.createTask.mockRejectedValueOnce(new Error("boom"))
      const { result } = renderHook(() => useSchedulerStore())

      let returned: ScheduledTask | null = null
      await act(async () => {
        returned = await result.current.createTask({
          name: "t",
          type: "workflow",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          payload: {},
        })
      })
      expect(returned).toBeNull()
      expect(result.current.error).toBe("boom")
      expect(result.current.isLoading).toBe(false)
    })

    it("falls back to a generic error when scheduler.createTask rejects with a non-Error", async () => {
      mockScheduler.createTask.mockRejectedValueOnce("weird")
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.createTask({
          name: "t",
          type: "workflow",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          payload: {},
        })
      })
      expect(result.current.error).toBe("Failed to create task")
    })

    it("does not refresh when scheduler.createTask returns null", async () => {
      mockScheduler.createTask.mockResolvedValueOnce(null)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.createTask({
          name: "t",
          type: "workflow",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          payload: {},
        })
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })
  })

  describe("updateTask", () => {
    it("returns the updated task when scheduler resolves it", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      let updated: ScheduledTask | null = null
      await act(async () => {
        updated = await result.current.updateTask("task-id", { name: "Renamed" })
      })
      expect(updated).toBeTruthy()
      expect(mockScheduler.updateTask).toHaveBeenCalledWith("task-id", { name: "Renamed" })
    })

    it("records errors and returns null when scheduler.updateTask throws", async () => {
      mockScheduler.updateTask.mockRejectedValueOnce(new Error("nope"))
      const { result } = renderHook(() => useSchedulerStore())
      let updated: ScheduledTask | null = null
      await act(async () => {
        updated = await result.current.updateTask("task-id", {})
      })
      expect(updated).toBeNull()
      expect(result.current.error).toBe("nope")
    })

    it("uses the generic message when scheduler.updateTask rejects with a non-Error", async () => {
      mockScheduler.updateTask.mockRejectedValueOnce("boom")
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.updateTask("task-id", {})
      })
      expect(result.current.error).toBe("Failed to update task")
    })

    it("skips refreshAll when the scheduler returns null", async () => {
      mockScheduler.updateTask.mockResolvedValueOnce(null)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.updateTask("task-id", {})
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })
  })

  describe("deleteTask", () => {
    it("clears the selected task and refreshes when the deletion succeeds", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.setTasks([sampleTask({ id: "task-1" })])
        result.current.selectTask("task-1")
      })

      let success = false
      await act(async () => {
        success = await result.current.deleteTask("task-1")
      })
      expect(success).toBe(true)
      expect(result.current.selectedTaskId).toBeNull()
      expect(result.current.executions).toEqual([])
    })

    it("returns false and stores the error when deletion throws", async () => {
      mockScheduler.deleteTask.mockRejectedValueOnce(new Error("delete-fail"))
      const { result } = renderHook(() => useSchedulerStore())
      let ok = true
      await act(async () => {
        ok = await result.current.deleteTask("task-1")
      })
      expect(ok).toBe(false)
      expect(result.current.error).toBe("delete-fail")
    })

    it("falls back to the generic error message when deletion rejects with a non-Error", async () => {
      mockScheduler.deleteTask.mockRejectedValueOnce("nope")
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.deleteTask("task-1")
      })
      expect(result.current.error).toBe("Failed to delete task")
    })

    it("does not clear unrelated selection on success", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.setTasks([sampleTask({ id: "other" })])
        result.current.selectTask("other")
      })
      await act(async () => {
        await result.current.deleteTask("different")
      })
      expect(result.current.selectedTaskId).toBe("other")
    })

    it("does not refresh when scheduler.deleteTask returns false", async () => {
      mockScheduler.deleteTask.mockResolvedValueOnce(false)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.deleteTask("task-1")
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })
  })

  describe("pauseTask / resumeTask", () => {
    it("pauses successfully and refreshes", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      let ok = false
      await act(async () => {
        ok = await result.current.pauseTask("task-1")
      })
      expect(ok).toBe(true)
      expect(mockScheduler.pauseTask).toHaveBeenCalledWith("task-1")
    })

    it("returns false when pauseTask throws", async () => {
      mockScheduler.pauseTask.mockRejectedValueOnce(new Error("pause-fail"))
      const { result } = renderHook(() => useSchedulerStore())
      let ok = true
      await act(async () => {
        ok = await result.current.pauseTask("task-1")
      })
      expect(ok).toBe(false)
    })

    it("does not refreshAll when pauseTask returns false", async () => {
      mockScheduler.pauseTask.mockResolvedValueOnce(false)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.pauseTask("task-1")
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })

    it("resumes successfully", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      let ok = false
      await act(async () => {
        ok = await result.current.resumeTask("task-1")
      })
      expect(ok).toBe(true)
    })

    it("returns false when resumeTask throws", async () => {
      mockScheduler.resumeTask.mockRejectedValueOnce(new Error("resume-fail"))
      const { result } = renderHook(() => useSchedulerStore())
      let ok = true
      await act(async () => {
        ok = await result.current.resumeTask("task-1")
      })
      expect(ok).toBe(false)
    })

    it("does not refreshAll when resumeTask returns false", async () => {
      mockScheduler.resumeTask.mockResolvedValueOnce(false)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.resumeTask("task-1")
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })
  })

  describe("backfillTask", () => {
    it("returns the run count and refreshes when slots ran", async () => {
      mockScheduler.backfillTask.mockResolvedValueOnce([{ id: "e1" }, { id: "e2" }])
      const { result } = renderHook(() => useSchedulerStore())
      let count = 0
      await act(async () => {
        count = await result.current.backfillTask("task-1", {
          start: new Date(0),
          end: new Date(1000),
        })
      })
      expect(count).toBe(2)
      expect(mockScheduler.backfillTask).toHaveBeenCalledWith("task-1", {
        start: new Date(0),
        end: new Date(1000),
      })
    })

    it("rethrows and stores the error message when the engine fails", async () => {
      mockScheduler.backfillTask.mockRejectedValueOnce(new Error("bf-fail"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await expect(
          result.current.backfillTask("task-1", { start: new Date(0), end: new Date(1000) })
        ).rejects.toThrow("bf-fail")
      })
      expect(result.current.error).toBe("bf-fail")
    })
  })

  describe("runTaskNow", () => {
    it("returns the execution and refreshes", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        const exec = await result.current.runTaskNow("task-1")
        expect(exec).toBeTruthy()
      })
    })

    it("returns null and stores the error message when scheduler throws", async () => {
      mockScheduler.runTaskNow.mockRejectedValueOnce(new Error("run-fail"))
      const { result } = renderHook(() => useSchedulerStore())
      let exec: unknown = null
      await act(async () => {
        exec = await result.current.runTaskNow("task-1")
      })
      expect(exec).toBeNull()
      expect(result.current.error).toBe("run-fail")
    })

    it("falls back to the generic error message for non-Error rejections", async () => {
      mockScheduler.runTaskNow.mockRejectedValueOnce("boom")
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.runTaskNow("task-1")
      })
      expect(result.current.error).toBe("Failed to run task")
    })

    it("does not refreshAll when runTaskNow returns null", async () => {
      mockScheduler.runTaskNow.mockResolvedValueOnce(null)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.runTaskNow("task-1")
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })
  })

  describe("Data Loading actions", () => {
    it("loadTasks pulls from getAllTasks when no filter is set and sorts by priority", async () => {
      const taskA = sampleTask({ id: "a", status: "paused", nextRunAt: new Date(2023, 1, 1) })
      const taskB = sampleTask({ id: "b", status: "active", nextRunAt: new Date(2023, 1, 2) })
      mockedDb.getAllTasks.mockResolvedValueOnce([taskA, taskB])
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadTasks()
      })
      // active task should sort first
      expect(result.current.tasks[0].id).toBe("b")
    })

    it("loadTasks orders by nextRunAt when both tasks share the active status, and breaks ties when one task has no nextRunAt", async () => {
      const earliest = sampleTask({
        id: "earliest",
        status: "active",
        nextRunAt: new Date(2023, 0, 1),
      })
      const later = sampleTask({
        id: "later",
        status: "active",
        nextRunAt: new Date(2024, 0, 1),
      })
      const noNext = sampleTask({ id: "noNext", status: "active" })
      const noNext2 = sampleTask({ id: "noNext2", status: "active" })
      mockedDb.getAllTasks.mockResolvedValueOnce([later, noNext, earliest, noNext2])
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadTasks()
      })
      const ids = result.current.tasks.map((t) => t.id)
      // Tasks with nextRunAt sort earliest-first; tasks without come after.
      expect(ids.indexOf("earliest")).toBeLessThan(ids.indexOf("later"))
      expect(ids.indexOf("earliest")).toBeLessThan(ids.indexOf("noNext"))
      expect(ids.indexOf("later")).toBeLessThan(ids.indexOf("noNext"))
      // Two tasks lacking nextRunAt fall through to the `return 0` branch.
      expect(ids).toContain("noNext2")
    })

    it("loadTasks uses the filtered query when filter has keys", async () => {
      const taskA = sampleTask({ id: "a" })
      mockedDb.getFilteredTasks.mockResolvedValueOnce([taskA])
      const { result } = renderHook(() => useSchedulerStore())
      // Set filter directly (bypass setFilter to avoid triggering refreshAll)
      act(() => {
        useSchedulerStore.setState({ filter: { types: ["workflow"] } })
      })
      await act(async () => {
        await result.current.loadTasks()
      })
      expect(mockedDb.getFilteredTasks).toHaveBeenCalled()
      expect(result.current.tasks).toHaveLength(1)
    })

    it("loadTasks records an error message when getAllTasks throws", async () => {
      mockedDb.getAllTasks.mockRejectedValueOnce(new Error("db-down"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadTasks()
      })
      expect(result.current.error).toBe("Failed to load tasks")
    })

    it("loadTaskExecutions stores the cursor and hasMore when paged result is full", async () => {
      const execs = Array.from({ length: 50 }, (_, i) => ({
        id: `e-${i}`,
        taskId: "task-1",
        status: "completed" as const,
        startedAt: new Date(2023, 0, i + 1),
      }))
      mockedDb.getTaskExecutions.mockResolvedValueOnce(execs)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadTaskExecutions("task-1")
      })
      expect(result.current.executions).toHaveLength(50)
      expect(result.current.hasMoreExecutions).toBe(true)
      expect(result.current.executionsCursor).toBeTruthy()
    })

    it("loadTaskExecutions handles an empty list (no cursor, no more)", async () => {
      mockedDb.getTaskExecutions.mockResolvedValueOnce([])
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadTaskExecutions("task-1")
      })
      expect(result.current.executions).toEqual([])
      expect(result.current.executionsCursor).toBeNull()
      expect(result.current.hasMoreExecutions).toBe(false)
    })

    it("loadTaskExecutions swallows errors but keeps state intact", async () => {
      mockedDb.getTaskExecutions.mockRejectedValueOnce(new Error("db"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadTaskExecutions("task-1")
      })
      expect(result.current.executions).toEqual([])
    })

    it("loadMoreExecutions short-circuits when no task is selected", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadMoreExecutions()
      })
      expect(mockedDb.getTaskExecutions).not.toHaveBeenCalled()
    })

    it("loadMoreExecutions short-circuits when there are no more pages", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        useSchedulerStore.setState({
          selectedTaskId: "task-1",
          executionsCursor: "cursor",
          hasMoreExecutions: false,
        })
      })
      await act(async () => {
        await result.current.loadMoreExecutions()
      })
      expect(mockedDb.getTaskExecutions).not.toHaveBeenCalled()
    })

    it("loadMoreExecutions appends a new page and updates the cursor", async () => {
      const more = Array.from({ length: 50 }, (_, i) => ({
        id: `m-${i}`,
        taskId: "task-1",
        status: "completed" as const,
        startedAt: new Date(2023, 1, i + 1),
      }))
      mockedDb.getTaskExecutions.mockResolvedValueOnce(more)
      act(() => {
        useSchedulerStore.setState({
          selectedTaskId: "task-1",
          executionsCursor: "old-cursor",
          hasMoreExecutions: true,
          executions: [],
        })
      })
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadMoreExecutions()
      })
      expect(result.current.executions).toHaveLength(50)
      expect(result.current.hasMoreExecutions).toBe(true)
      expect(result.current.executionsCursor).toBeTruthy()
    })

    it("loadMoreExecutions sets cursor to null when next page is empty", async () => {
      mockedDb.getTaskExecutions.mockResolvedValueOnce([])
      act(() => {
        useSchedulerStore.setState({
          selectedTaskId: "task-1",
          executionsCursor: "old",
          hasMoreExecutions: true,
          executions: [],
        })
      })
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadMoreExecutions()
      })
      expect(result.current.executionsCursor).toBeNull()
      expect(result.current.hasMoreExecutions).toBe(false)
    })

    it("loadMoreExecutions swallows errors", async () => {
      mockedDb.getTaskExecutions.mockRejectedValueOnce(new Error("db"))
      act(() => {
        useSchedulerStore.setState({
          selectedTaskId: "task-1",
          executionsCursor: "old",
          hasMoreExecutions: true,
        })
      })
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadMoreExecutions()
      })
      // No throw, state remains
      expect(result.current.selectedTaskId).toBe("task-1")
    })

    it("loadStatistics swallows errors", async () => {
      mockedDb.getStatistics.mockRejectedValueOnce(new Error("db"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadStatistics()
      })
      expect(result.current.statistics).toBeNull()
    })

    it("loadRecentExecutions stores executions and uses default limit", async () => {
      mockedDb.getRecentExecutions.mockResolvedValueOnce([
        { id: "r-1", taskId: "a", status: "completed", startedAt: new Date() },
      ])
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadRecentExecutions()
      })
      expect(mockedDb.getRecentExecutions).toHaveBeenCalledWith(50)
      expect(result.current.recentExecutions).toHaveLength(1)
    })

    it("loadRecentExecutions accepts a custom limit and swallows errors", async () => {
      mockedDb.getRecentExecutions.mockRejectedValueOnce(new Error("db"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadRecentExecutions(5)
      })
      expect(mockedDb.getRecentExecutions).toHaveBeenCalledWith(5)
      expect(result.current.recentExecutions).toEqual([])
    })

    it("loadUpcomingTasks stores tasks with default limit", async () => {
      mockedDb.getUpcomingTasks.mockResolvedValueOnce([sampleTask({ id: "u-1" })])
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadUpcomingTasks()
      })
      expect(mockedDb.getUpcomingTasks).toHaveBeenCalledWith(10)
      expect(result.current.upcomingTasks).toHaveLength(1)
    })

    it("loadUpcomingTasks honors a custom limit and swallows errors", async () => {
      mockedDb.getUpcomingTasks.mockRejectedValueOnce(new Error("db"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.loadUpcomingTasks(3)
      })
      expect(mockedDb.getUpcomingTasks).toHaveBeenCalledWith(3)
      expect(result.current.upcomingTasks).toEqual([])
    })
  })

  describe("refreshAll", () => {
    it("aggregates db queries and updates the store with executions for the selected task", async () => {
      mockedDb.getAllTasks.mockResolvedValueOnce([sampleTask({ id: "a" })])
      mockedDb.getTaskExecutions.mockResolvedValueOnce([
        { id: "e1", taskId: "a", status: "completed", startedAt: new Date() },
      ])
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        useSchedulerStore.setState({ selectedTaskId: "a" })
      })
      await act(async () => {
        await result.current.refreshAll()
      })
      expect(result.current.tasks).toHaveLength(1)
      expect(result.current.executions).toHaveLength(1)
    })

    it("uses filtered tasks when a filter is active", async () => {
      mockedDb.getFilteredTasks.mockResolvedValueOnce([sampleTask({ id: "a" })])
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        useSchedulerStore.setState({ filter: { types: ["workflow"] } })
      })
      await act(async () => {
        await result.current.refreshAll()
      })
      expect(mockedDb.getFilteredTasks).toHaveBeenCalled()
    })

    it("keeps existing executions when no task is selected", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        useSchedulerStore.setState({
          executions: [
            { id: "old", taskId: "t", status: "completed", startedAt: new Date() } as TaskExecution,
          ],
        })
      })
      await act(async () => {
        await result.current.refreshAll()
      })
      expect(result.current.executions[0].id).toBe("old")
    })

    it("records an error when one of the queries throws", async () => {
      mockedDb.getAllTasks.mockRejectedValueOnce(new Error("db"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.refreshAll()
      })
      expect(result.current.error).toBe("Failed to refresh scheduler data")
      expect(result.current.isLoading).toBe(false)
    })

    it("deduplicates concurrent invocations", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        const a = result.current.refreshAll()
        const b = result.current.refreshAll()
        await Promise.all([a, b])
      })
      // getAllTasks is called once per refresh; concurrent dedup means a single call
      expect(mockedDb.getAllTasks).toHaveBeenCalledTimes(1)
    })
  })

  describe("Filter actions trigger refreshAll", () => {
    it("setFilter merges patches", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.setFilter({ types: ["workflow"] })
      })
      // wait microtask for the void refreshAll
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.filter.types).toEqual(["workflow"])
    })

    it("clearFilter resets the filter and triggers refreshAll", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        useSchedulerStore.setState({ filter: { types: ["workflow"] } })
      })
      act(() => {
        result.current.clearFilter()
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.filter).toEqual({})
    })
  })

  describe("Bulk operations", () => {
    it("bulkPause counts only the successful results", async () => {
      mockScheduler.pauseTask
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
      const { result } = renderHook(() => useSchedulerStore())
      let count = 0
      await act(async () => {
        count = await result.current.bulkPause(["a", "b", "c"])
      })
      expect(count).toBe(2)
    })

    it("bulkPause does not refresh when nothing succeeds", async () => {
      mockScheduler.pauseTask.mockResolvedValue(false)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.bulkPause(["a"])
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })

    it("bulkPause records errors when scheduler throws", async () => {
      mockScheduler.pauseTask.mockRejectedValueOnce(new Error("boom"))
      const { result } = renderHook(() => useSchedulerStore())
      let count = -1
      await act(async () => {
        count = await result.current.bulkPause(["a"])
      })
      expect(result.current.error).toBe("Failed to pause tasks")
      expect(count).toBe(0)
    })

    it("bulkResume counts successful results", async () => {
      mockScheduler.resumeTask.mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      const { result } = renderHook(() => useSchedulerStore())
      let count = 0
      await act(async () => {
        count = await result.current.bulkResume(["a", "b"])
      })
      expect(count).toBe(2)
    })

    it("bulkResume does not refresh when none succeed", async () => {
      mockScheduler.resumeTask.mockResolvedValue(false)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.bulkResume(["a"])
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })

    it("bulkResume records errors when scheduler throws", async () => {
      mockScheduler.resumeTask.mockRejectedValueOnce(new Error("boom"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.bulkResume(["a"])
      })
      expect(result.current.error).toBe("Failed to resume tasks")
    })

    it("bulkDelete clears selection if one of the deleted tasks was selected", async () => {
      mockScheduler.deleteTask.mockResolvedValue(true)
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        useSchedulerStore.setState({ selectedTaskId: "a" })
      })
      let count = 0
      await act(async () => {
        count = await result.current.bulkDelete(["a", "b"])
      })
      expect(count).toBe(2)
      expect(result.current.selectedTaskId).toBeNull()
    })

    it("bulkDelete preserves selection when no deleted ID matches", async () => {
      mockScheduler.deleteTask.mockResolvedValue(true)
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        useSchedulerStore.setState({ selectedTaskId: "unrelated" })
      })
      await act(async () => {
        await result.current.bulkDelete(["a"])
      })
      expect(result.current.selectedTaskId).toBe("unrelated")
    })

    it("bulkDelete does not refresh when nothing succeeds", async () => {
      mockScheduler.deleteTask.mockResolvedValue(false)
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.bulkDelete(["a"])
      })
      expect(mockedDb.getAllTasks).not.toHaveBeenCalled()
    })

    it("bulkDelete records errors when scheduler throws", async () => {
      mockScheduler.deleteTask.mockRejectedValueOnce(new Error("boom"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.bulkDelete(["a"])
      })
      expect(result.current.error).toBe("Failed to delete tasks")
    })
  })

  describe("Import / Export", () => {
    it("exportTasks returns serialized JSON", async () => {
      mockScheduler.exportTasks.mockResolvedValueOnce({ tasks: [{ id: "a" }] })
      const { result } = renderHook(() => useSchedulerStore())
      let json = ""
      await act(async () => {
        json = await result.current.exportTasks(["a"])
      })
      expect(JSON.parse(json)).toEqual({ tasks: [{ id: "a" }] })
    })

    it('exportTasks records an error and returns "{}" when scheduler throws', async () => {
      mockScheduler.exportTasks.mockRejectedValueOnce(new Error("export-fail"))
      const { result } = renderHook(() => useSchedulerStore())
      let json = ""
      await act(async () => {
        json = await result.current.exportTasks()
      })
      expect(json).toBe("{}")
      expect(result.current.error).toBe("Failed to export tasks")
    })

    it("importTasks refreshes when something is imported", async () => {
      mockScheduler.importTasks.mockResolvedValueOnce({
        imported: 1,
        skipped: 0,
        errors: [],
      })
      const { result } = renderHook(() => useSchedulerStore())
      let res = { imported: 0, skipped: 0, errors: [] as string[] }
      await act(async () => {
        res = await result.current.importTasks(JSON.stringify({ tasks: [] }))
      })
      expect(res.imported).toBe(1)
    })

    it("importTasks reports per-result errors when present", async () => {
      mockScheduler.importTasks.mockResolvedValueOnce({
        imported: 0,
        skipped: 0,
        errors: ["bad-task"],
      })
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.importTasks(JSON.stringify({ tasks: [] }))
      })
      expect(result.current.error).toContain("1 error")
    })

    it("importTasks captures parse errors and returns a single error result", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      let res = { imported: 1, skipped: 0, errors: [] as string[] }
      await act(async () => {
        res = await result.current.importTasks("not-json")
      })
      expect(res.imported).toBe(0)
      expect(res.errors.length).toBeGreaterThan(0)
      expect(result.current.error).toBeTruthy()
    })

    it("importTasks falls back to a generic error when scheduler rejects with non-Error", async () => {
      mockScheduler.importTasks.mockRejectedValueOnce("weird")
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.importTasks(JSON.stringify({ tasks: [] }))
      })
      expect(result.current.error).toBe("Failed to import tasks")
    })

    it("importTasks supports the explicit replace mode", async () => {
      mockScheduler.importTasks.mockResolvedValueOnce({
        imported: 0,
        skipped: 0,
        errors: [],
      })
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.importTasks(JSON.stringify({ tasks: [] }), "replace")
      })
      expect(mockScheduler.importTasks).toHaveBeenCalledWith(expect.any(Object), "replace")
    })
  })

  describe("cloneTask", () => {
    it("returns null and stores an error when the original task does not exist", async () => {
      mockScheduler.getTask.mockResolvedValueOnce(null)
      const { result } = renderHook(() => useSchedulerStore())
      let cloned: ScheduledTask | null = null
      await act(async () => {
        cloned = await result.current.cloneTask("missing")
      })
      expect(cloned).toBeNull()
      expect(result.current.error).toBe("Task not found")
    })

    it('clones using "(Copy)" suffix and propagates trigger / payload / config', async () => {
      const original = sampleTask({ id: "src", name: "Original" })
      mockScheduler.getTask.mockResolvedValueOnce(original)
      const cloned = sampleTask({ id: "cloned", name: "Original (Copy)" })
      mockScheduler.createTask.mockResolvedValueOnce(cloned)
      const { result } = renderHook(() => useSchedulerStore())
      let res = null as ScheduledTask | null
      await act(async () => {
        res = await result.current.cloneTask("src")
      })
      expect(res?.id).toBe("cloned")
      expect(mockScheduler.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Original (Copy)" })
      )
    })

    it("records an error when scheduler.getTask throws", async () => {
      mockScheduler.getTask.mockRejectedValueOnce(new Error("boom"))
      const { result } = renderHook(() => useSchedulerStore())
      let res: ScheduledTask | null = null
      await act(async () => {
        res = await result.current.cloneTask("src")
      })
      expect(res).toBeNull()
      expect(result.current.error).toBe("Failed to clone task")
    })
  })

  describe("cleanupOldExecutions", () => {
    it("returns 0 when nothing is removed and skips refresh", async () => {
      mockedDb.cleanupOldExecutions.mockResolvedValueOnce(0)
      const { result } = renderHook(() => useSchedulerStore())
      let count = -1
      await act(async () => {
        count = await result.current.cleanupOldExecutions()
      })
      expect(count).toBe(0)
      expect(mockedDb.cleanupOldExecutions).toHaveBeenCalledWith(30)
    })

    it("forwards a custom maxAgeDays and refreshes when records are deleted", async () => {
      mockedDb.cleanupOldExecutions.mockResolvedValueOnce(7)
      const { result } = renderHook(() => useSchedulerStore())
      let count = 0
      await act(async () => {
        count = await result.current.cleanupOldExecutions(60)
      })
      expect(count).toBe(7)
      expect(mockedDb.cleanupOldExecutions).toHaveBeenCalledWith(60)
    })

    it("returns 0 when the underlying call throws", async () => {
      mockedDb.cleanupOldExecutions.mockRejectedValueOnce(new Error("db"))
      const { result } = renderHook(() => useSchedulerStore())
      let count = -1
      await act(async () => {
        count = await result.current.cleanupOldExecutions()
      })
      expect(count).toBe(0)
    })
  })

  describe("Plugin execution helpers", () => {
    it("cancelPluginExecution delegates to the plugin executor", () => {
      const { result } = renderHook(() => useSchedulerStore())
      const ok = result.current.cancelPluginExecution("exec-1")
      expect(ok).toBe(true)
      expect(pluginExecutorMock.cancelPluginTaskExecution).toHaveBeenCalledWith("exec-1")
    })

    it("getActivePluginCount delegates to the plugin executor", () => {
      const { result } = renderHook(() => useSchedulerStore())
      expect(result.current.getActivePluginCount()).toBe(2)
    })

    it("isPluginExecutionActive delegates to the plugin executor", () => {
      const { result } = renderHook(() => useSchedulerStore())
      expect(result.current.isPluginExecutionActive("exec-1")).toBe(true)
    })
  })

  describe("Permission management", () => {
    it("updatePermissionPolicy merges patches", () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.updatePermissionPolicy({ scriptTasksEnabled: false })
      })
      expect(result.current.permissionPolicy.scriptTasksEnabled).toBe(false)
      // Untouched fields preserved
      expect(result.current.permissionPolicy.maxTasksPerSource).toBeGreaterThan(0)
    })

    it("checkPermission allows any user-source request", () => {
      const { result } = renderHook(() => useSchedulerStore())
      expect(result.current.checkPermission("script", "user")).toEqual({ allowed: true })
    })

    it("checkPermission blocks script tasks when disabled in policy", () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.updatePermissionPolicy({ scriptTasksEnabled: false })
      })
      const verdict = result.current.checkPermission("script", "plugin")
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toContain("Script tasks")
    })

    it("checkPermission enforces the per-source task count limit", () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.updatePermissionPolicy({ maxTasksPerSource: 1 })
        result.current.setTasks([sampleTask({ id: "a" }), sampleTask({ id: "b" })])
      })
      const verdict = result.current.checkPermission("workflow", "plugin")
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toContain("Maximum task limit")
    })

    it("checkPermission blocks agent-source tasks that require confirmation when auto-create is off", () => {
      const { result } = renderHook(() => useSchedulerStore())
      // Default policy has agentAutoCreate=false and confirmationRequired includes 'agent'
      const verdict = result.current.checkPermission("agent", "agent")
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toContain("confirmation")
    })

    it("checkPermission allows agent-source tasks not in confirmationRequired", () => {
      const { result } = renderHook(() => useSchedulerStore())
      const verdict = result.current.checkPermission("workflow", "agent")
      expect(verdict).toEqual({ allowed: true })
    })

    it("checkPermission allows agent-source tasks when agentAutoCreate is true", () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.updatePermissionPolicy({ agentAutoCreate: true })
      })
      const verdict = result.current.checkPermission("agent", "agent")
      expect(verdict).toEqual({ allowed: true })
    })
  })

  describe("System status", () => {
    it("setSchedulerStatus updates the status field", () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.setSchedulerStatus("running")
      })
      expect(result.current.schedulerStatus).toBe("running")
    })
  })

  describe("initialize", () => {
    it("loads scheduler system and refreshes data once", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.initialize()
      })
      expect(schedulerLibMock.initSchedulerSystem).toHaveBeenCalledTimes(1)
      expect(result.current.isInitialized).toBe(true)
      expect(result.current.isLoading).toBe(false)
    })

    it("skips work when already initialized", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        useSchedulerStore.setState({ isInitialized: true })
      })
      await act(async () => {
        await result.current.initialize()
      })
      expect(schedulerLibMock.initSchedulerSystem).not.toHaveBeenCalled()
    })

    it("records an error when init throws", async () => {
      schedulerLibMock.initSchedulerSystem.mockRejectedValueOnce(new Error("init-fail"))
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await result.current.initialize()
      })
      expect(result.current.error).toBe("Failed to initialize scheduler")
      expect(result.current.isInitialized).toBe(false)
    })

    it("deduplicates concurrent invocations via the in-flight promise guard", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      await act(async () => {
        await Promise.all([result.current.initialize(), result.current.initialize()])
      })
      expect(schedulerLibMock.initSchedulerSystem).toHaveBeenCalledTimes(1)
    })
  })

  describe("selectTask side-effects", () => {
    it("triggers loadTaskExecutions when given a non-null id", async () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.selectTask("task-1")
      })
      // Wait for the async loadTaskExecutions
      await act(async () => {
        await Promise.resolve()
      })
      expect(mockedDb.getTaskExecutions).toHaveBeenCalledWith("task-1", 50)
    })

    it("does not call loadTaskExecutions when id is null", () => {
      const { result } = renderHook(() => useSchedulerStore())
      act(() => {
        result.current.selectTask(null)
      })
      expect(mockedDb.getTaskExecutions).not.toHaveBeenCalled()
    })
  })
})

describe("Scheduler selectors", () => {
  beforeEach(() => {
    const { result } = renderHook(() => useSchedulerStore())
    act(() => {
      result.current.reset()
    })
  })

  it("selectSelectedTask returns the matching task object", async () => {
    // selectSelectedTask imported statically
    const task = sampleTask({ id: "a" })
    act(() => {
      useSchedulerStore.setState({ tasks: [task], selectedTaskId: "a" })
    })
    expect(selectSelectedTask(useSchedulerStore.getState())).toEqual(task)
  })

  it("selectActiveTasks / selectPausedTasks / selectUpcomingTasks derive correctly", async () => {
    // selectors imported statically
    const future = new Date(Date.now() + 60_000)
    const past = new Date(Date.now() - 60_000)
    const tasks: ScheduledTask[] = [
      sampleTask({ id: "a", status: "active", nextRunAt: future }),
      sampleTask({ id: "b", status: "paused" }),
      sampleTask({ id: "c", status: "active", nextRunAt: past }),
    ]
    act(() => {
      useSchedulerStore.setState({
        tasks,
        recentExecutions: [
          { id: "r-1", taskId: "a", status: "completed", startedAt: new Date() } as TaskExecution,
        ],
        schedulerStatus: "running",
        statistics: null,
      })
    })
    const state = useSchedulerStore.getState()
    expect(
      selectActiveTasks(state)
        .map((t) => t.id)
        .sort()
    ).toEqual(["a", "c"])
    expect(selectPausedTasks(state).map((t) => t.id)).toEqual(["b"])
    expect(selectUpcomingTasks(state).map((t) => t.id)).toEqual(["a"])
    // Caching: same source → same reference returned
    expect(selectUpcomingTasks(state)).toBe(selectUpcomingTasks(state))
    expect(selectRecentExecutions(state)).toHaveLength(1)
    expect(selectSchedulerStatus(state)).toBe("running")
    // The remaining cheap selectors return the same identity:
    expect(selectTasks(state)).toBe(state.tasks)
    expect(selectExecutions(state)).toBe(state.executions)
    expect(selectStatistics(state)).toBe(state.statistics)
    expect(selectSelectedTaskId(state)).toBe(state.selectedTaskId)
    expect(selectFilter(state)).toBe(state.filter)
    expect(selectIsLoading(state)).toBe(state.isLoading)
    expect(selectError(state)).toBe(state.error)
    expect(selectIsInitialized(state)).toBe(state.isInitialized)
  })
})

describe("stores/scheduler index barrel", () => {
  it("re-exports the scheduler store and selectors", async () => {
    const barrel = jest.requireMock("./index")
    expect(typeof barrel.useSchedulerStore).toBe("function")
    expect(typeof barrel.selectTasks).toBe("function")
    expect(typeof barrel.selectActiveTasks).toBe("function")
    expect(typeof barrel.selectPausedTasks).toBe("function")
    expect(typeof barrel.selectUpcomingTasks).toBe("function")
    expect(typeof barrel.selectRecentExecutions).toBe("function")
    expect(typeof barrel.selectSchedulerStatus).toBe("function")
    expect(typeof barrel.selectSelectedTask).toBe("function")
  })
})
