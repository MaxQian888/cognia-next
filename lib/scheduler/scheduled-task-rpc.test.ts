/** @jest-environment jsdom */

const scheduler = {
  getTask: jest.fn(),
  createTask: jest.fn(),
  updateTask: jest.fn(),
  deleteTask: jest.fn(),
  pauseTask: jest.fn(),
  resumeTask: jest.fn(),
  runTaskNow: jest.fn(),
  backfillTask: jest.fn(),
  exportTasks: jest.fn(),
  importTasks: jest.fn(),
  triggerEventTask: jest.fn(),
  cancelExecution: jest.fn(),
}
jest.mock("./task-scheduler", () => ({ getTaskScheduler: () => scheduler }))
jest.mock("./scheduler-db", () => {
  const mockSchedulerDb = {
    getFilteredTasks: jest.fn(),
    getAllTasks: jest.fn(),
    getTaskExecutions: jest.fn(),
    getRecentExecutions: jest.fn(),
    getStatistics: jest.fn(),
    getUpcomingTasks: jest.fn(),
    cleanupOldExecutions: jest.fn(),
  }
  return { schedulerDb: mockSchedulerDb }
})

import { dispatchScheduledTaskRpc, isScheduledTaskRpc } from "./scheduled-task-rpc"

const { schedulerDb } = jest.requireMock("./scheduler-db") as {
  schedulerDb: {
    getFilteredTasks: jest.Mock
    getAllTasks: jest.Mock
    getTaskExecutions: jest.Mock
    getRecentExecutions: jest.Mock
    getStatistics: jest.Mock
    getUpcomingTasks: jest.Mock
    cleanupOldExecutions: jest.Mock
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

it("recognizes only the dedicated app-scheduler command family", () => {
  expect(isScheduledTaskRpc("scheduled_task_list")).toBe(true)
  expect(isScheduledTaskRpc("scheduler_list_tasks")).toBe(false)
})

it("lists filtered tasks and pages a task's executions", async () => {
  schedulerDb.getFilteredTasks.mockResolvedValue([])
  schedulerDb.getTaskExecutions.mockResolvedValue([])

  await dispatchScheduledTaskRpc("scheduled_task_list", { filter: { statuses: ["active"] } })
  await dispatchScheduledTaskRpc("scheduled_task_runs", {
    taskId: "task-1",
    limit: 500,
    beforeStartedAt: "2026-07-30T00:00:00.000Z",
  })

  expect(schedulerDb.getFilteredTasks).toHaveBeenCalledWith({ statuses: ["active"] })
  expect(schedulerDb.getTaskExecutions).toHaveBeenCalledWith(
    "task-1",
    200,
    "2026-07-30T00:00:00.000Z"
  )
})

it("revives date fields before creating and backfilling", async () => {
  scheduler.createTask.mockResolvedValue({})
  scheduler.backfillTask.mockResolvedValue([])

  await dispatchScheduledTaskRpc("scheduled_task_create", {
    input: {
      name: "Once",
      type: "chat",
      trigger: { type: "once", runAt: "2026-07-31T00:00:00.000Z" },
      endAt: "2026-08-01T00:00:00.000Z",
    },
  })
  await dispatchScheduledTaskRpc("scheduled_task_backfill", {
    taskId: "task-1",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-02T00:00:00.000Z",
  })

  expect(scheduler.createTask).toHaveBeenCalledWith(
    expect.objectContaining({
      endAt: expect.any(Date),
      trigger: expect.objectContaining({ runAt: expect.any(Date) }),
    })
  )
  expect(scheduler.backfillTask).toHaveBeenCalledWith("task-1", {
    start: expect.any(Date),
    end: expect.any(Date),
  })
})

it("rejects malformed ids and dates at the RPC boundary", async () => {
  await expect(dispatchScheduledTaskRpc("scheduled_task_get", {})).rejects.toThrow(
    "taskId is required"
  )
  await expect(
    dispatchScheduledTaskRpc("scheduled_task_backfill", {
      taskId: "task-1",
      start: "not-a-date",
      end: "2026-07-02T00:00:00.000Z",
    })
  ).rejects.toThrow("start must be an ISO date")
})

it("forwards remote host events into event-triggered tasks", async () => {
  scheduler.triggerEventTask.mockResolvedValue(undefined)
  await dispatchScheduledTaskRpc("scheduled_task_emit_event", {
    eventType: "job:exited",
    eventSource: "job-1",
    data: { jobId: "job-1" },
  })
  expect(scheduler.triggerEventTask).toHaveBeenCalledWith("job:exited", "job-1", {
    jobId: "job-1",
  })
})

describe("scheduled_task_cancel_run", () => {
  it("is part of the family, so the bridge routes it here", () => {
    expect(isScheduledTaskRpc("scheduled_task_cancel_run")).toBe(true)
  })

  it("stops the run the caller named", async () => {
    scheduler.cancelExecution.mockResolvedValue({ cancelled: true })

    await expect(
      dispatchScheduledTaskRpc("scheduled_task_cancel_run", { runId: "run-9" })
    ).resolves.toEqual({ cancelled: true })
    expect(scheduler.cancelExecution).toHaveBeenCalledWith("run-9")
  })

  it("passes the host's own outcome back verbatim", async () => {
    // The distinction a remote caller cannot make for itself: only this host
    // knows whether the run had already settled.
    scheduler.cancelExecution.mockResolvedValue({
      cancelled: false,
      reason: "already-settled",
      status: "completed",
    })

    await expect(
      dispatchScheduledTaskRpc("scheduled_task_cancel_run", { runId: "run-9" })
    ).resolves.toMatchObject({ reason: "already-settled", status: "completed" })
  })

  it("refuses a call with no run id rather than cancelling something else", async () => {
    await expect(dispatchScheduledTaskRpc("scheduled_task_cancel_run", {})).rejects.toThrow(
      /runId is required/
    )
    expect(scheduler.cancelExecution).not.toHaveBeenCalled()
  })
})
