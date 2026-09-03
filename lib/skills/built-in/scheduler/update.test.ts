/** @jest-environment jsdom */
/**
 * `schedule.update`. Partial by field, except the payload, which is replaced
 * whole so a merge cannot leave a task nobody reviewed.
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

describe("schedule.update", () => {
  it("changes only the fields supplied", async () => {
    scheduler.updateTask.mockResolvedValue(task({ name: "Renamed" }))
    await run("schedule.update", { taskId: "task-1", name: "Renamed" })
    expect(scheduler.updateTask).toHaveBeenCalledWith("task-1", { name: "Renamed" })
  })

  it("replaces the payload rather than merging it", async () => {
    // A partial merge of a chat payload can leave `prompt` from the old task
    // beside `characterId` from the new one, which is a task nobody reviewed.
    scheduler.updateTask.mockResolvedValue(task())
    await run("schedule.update", { taskId: "task-1", payload: { prompt: "new" } })
    expect(scheduler.updateTask).toHaveBeenCalledWith("task-1", { payload: { prompt: "new" } })
  })

  it("gates on the existing type, which it cannot change", async () => {
    scheduler.getTask.mockResolvedValue(task({ type: "background-command" }))
    scheduler.updateTask.mockResolvedValue(task({ type: "background-command" }))
    await run("schedule.update", { taskId: "task-1", name: "Renamed" })
    expect(authorizeTaskWrite).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "background-command" })
    )
  })

  it("reports a refusal from the scheduler instead of claiming success", async () => {
    scheduler.updateTask.mockResolvedValue(null)
    await expect(run("schedule.update", { taskId: "task-1", name: "x" })).rejects.toThrow(/task-1/)
  })
})
