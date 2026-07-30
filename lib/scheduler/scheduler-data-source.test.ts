/** @jest-environment jsdom */

const call = jest.fn()
let remoteActive = false

jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => call(...args) },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => remoteActive,
}))
jest.mock("./scheduler-db", () => ({
  schedulerDb: {
    getAllTasks: jest.fn(),
    getFilteredTasks: jest.fn(),
    getTaskExecutions: jest.fn(),
    getStatistics: jest.fn(),
    getRecentExecutions: jest.fn(),
    getUpcomingTasks: jest.fn(),
    cleanupOldExecutions: jest.fn(),
  },
}))
jest.mock("./task-scheduler", () => ({
  getTaskScheduler: jest.fn(() => ({
    createTask: jest.fn(),
    updateTask: jest.fn(),
    deleteTask: jest.fn(),
    getTask: jest.fn(),
    pauseTask: jest.fn(),
    resumeTask: jest.fn(),
    runTaskNow: jest.fn(),
    backfillTask: jest.fn(),
    exportTasks: jest.fn(),
    importTasks: jest.fn(),
  })),
}))

import { schedulerDb } from "./scheduler-db"
import { getSchedulerDataSource } from "./scheduler-data-source"

beforeEach(() => {
  call.mockReset()
  remoteActive = false
  jest.clearAllMocks()
})

it("uses the local scheduler database while no remote host is active", async () => {
  ;(schedulerDb.getAllTasks as jest.Mock).mockResolvedValue([])

  const source = getSchedulerDataSource()
  await source.listTasks()

  expect(source.host).toBe("local")
  expect(schedulerDb.getAllTasks).toHaveBeenCalled()
  expect(call).not.toHaveBeenCalled()
})

it("routes task reads to the active remote host and hydrates dates", async () => {
  remoteActive = true
  call.mockResolvedValue([
    {
      id: "task-1",
      name: "Remote",
      type: "chat",
      status: "active",
      trigger: { type: "once", runAt: "2026-07-31T00:00:00.000Z" },
      payload: {},
      config: {},
      notification: {},
      tags: [],
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T01:00:00.000Z",
      nextRunAt: "2026-07-31T00:00:00.000Z",
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      createdBy: { kind: "user" },
    },
  ])

  const source = getSchedulerDataSource()
  const tasks = await source.listTasks({ statuses: ["active"] })

  expect(source.host).toBe("remote")
  expect(call).toHaveBeenCalledWith("scheduled_task_list", {
    filter: { statuses: ["active"] },
  })
  expect(tasks[0]?.createdAt).toBeInstanceOf(Date)
  expect(tasks[0]?.nextRunAt).toBeInstanceOf(Date)
})

it("sends task provenance hints with remote mutations", async () => {
  remoteActive = true
  call.mockResolvedValueOnce(true).mockResolvedValueOnce(null)

  const source = getSchedulerDataSource()
  await source.deleteTask("task-1", "agent")
  await source.runTaskNow("task-1", { taskType: "agent", triggerSource: "run-now" })

  expect(call).toHaveBeenNthCalledWith(1, "scheduled_task_delete", {
    taskId: "task-1",
    taskType: "agent",
  })
  expect(call).toHaveBeenNthCalledWith(2, "scheduled_task_run_now", {
    taskId: "task-1",
    taskType: "agent",
    triggerSource: "run-now",
  })
})
