/** @jest-environment jsdom */
/**
 * `schedule.delete`. The only irreversible verb in the family, which is why it
 * carries the stricter tier and still consults the policy.
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

describe("schedule.delete", () => {
  it("deletes and reports what went", async () => {
    scheduler.deleteTask.mockResolvedValue(true)
    const result = (await run("schedule.delete", { taskId: "task-1" })) as { name: string }
    expect(result.name).toBe("Morning digest")
  })

  it("still asks the policy before an irreversible write", async () => {
    authorizeTaskWrite.mockResolvedValue({
      allowed: false,
      reason: "quota-exceeded",
      message: "limit reached",
    })
    await expect(run("schedule.delete", { taskId: "task-1" })).rejects.toThrow("limit reached")
    expect(scheduler.deleteTask).not.toHaveBeenCalled()
  })

  it("refuses an id that does not exist rather than reporting a deletion", async () => {
    scheduler.getTask.mockResolvedValue(null)
    await expect(run("schedule.delete", { taskId: "gone" })).rejects.toThrow(/gone/)
  })

  it("warns on the card that this cannot be undone", async () => {
    const rendered = JSON.stringify(skill("schedule.delete").hitlSurface!({ taskId: "t" } as never))
    expect(rendered).toContain("cannot be undone")
  })
})
