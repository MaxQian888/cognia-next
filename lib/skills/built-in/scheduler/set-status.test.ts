/** @jest-environment jsdom */
/**
 * `schedule.set_status`. Separate from `update` because pausing goes through
 * the scheduler's own lifecycle rather than a field write.
 */

const scheduler = {
  getAllTasks: jest.fn(),
  getTask: jest.fn(),
  getTaskExecutions: jest.fn(),
  createTask: jest.fn(),
  updateTask: jest.fn(),
  deleteTask: jest.fn(),
  pauseTask: jest.fn(),
  resumeTask: jest.fn(),
  runTaskNow: jest.fn(),
}
jest.mock("@/lib/scheduler/task-scheduler", () => ({ getTaskScheduler: () => scheduler }))

const authorizeTaskWrite = jest.fn()
jest.mock("@/lib/scheduler/write-authority", () => ({
  authorizeTaskWrite: (...args: unknown[]) => authorizeTaskWrite(...(args as [])),
  verdictNeedsConfirmation: (v: { allowed?: boolean; requiresConfirmation?: boolean }) =>
    Boolean(v?.allowed && v?.requiresConfirmation),
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkill, BuiltInSkillContext } from "../types"
import "./index"

const registry = getSharedBuiltInSkillRegistry()
const ctx = { sessionId: "sess-1" } as BuiltInSkillContext

function skill(id: string): BuiltInSkill {
  const found = registry.list().find((entry) => entry.id === id)
  if (!found) throw new Error(`skill not registered: ${id}`)
  return found
}

function run(id: string, args: unknown): Promise<unknown> {
  return skill(id).execute(args as never, ctx)
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    name: "Morning digest",
    type: "chat",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    runCount: 3,
    successCount: 2,
    failureCount: 1,
    createdBy: { kind: "agent", sessionId: "sess-1" },
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  authorizeTaskWrite.mockResolvedValue({ allowed: true })
  scheduler.getTask.mockResolvedValue(task())
  scheduler.getAllTasks.mockResolvedValue([])
  scheduler.getTaskExecutions.mockResolvedValue([])
})

describe("schedule.set_status", () => {
  it("resumes through the scheduler so the next run is recomputed", async () => {
    // Writing `status: "active"` through updateTask would leave a resumed task
    // with a next run in the past, straight into the missed-run sweep.
    scheduler.resumeTask.mockResolvedValue(true)
    await run("schedule.set_status", { taskId: "task-1", status: "active" })
    expect(scheduler.resumeTask).toHaveBeenCalledWith("task-1")
    expect(scheduler.updateTask).not.toHaveBeenCalled()
  })

  it("pauses through the scheduler too", async () => {
    scheduler.pauseTask.mockResolvedValue(true)
    await run("schedule.set_status", { taskId: "task-1", status: "paused" })
    expect(scheduler.pauseTask).toHaveBeenCalledWith("task-1")
    expect(scheduler.updateTask).not.toHaveBeenCalled()
  })

  it("reports the persisted state, not the requested one", async () => {
    scheduler.pauseTask.mockResolvedValue(true)
    scheduler.getTask
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ status: "paused" }))
    const result = (await run("schedule.set_status", {
      taskId: "task-1",
      status: "paused",
    })) as { task: { status: string } }
    expect(result.task.status).toBe("paused")
  })

  it("raises the scheduler's refusal rather than reporting a silent success", async () => {
    scheduler.pauseTask.mockResolvedValue(false)
    await expect(
      run("schedule.set_status", { taskId: "task-1", status: "paused" })
    ).rejects.toThrow(/task-1/)
  })
})
