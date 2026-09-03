/** @jest-environment jsdom */
/**
 * `schedule.list`. The tool every other skill in the family depends on, since
 * they all take a task id and there was previously no way to obtain one.
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

describe("schedule.list", () => {
  it("orders by soonest next run, putting unscheduled ones last", async () => {
    scheduler.getAllTasks.mockResolvedValue([
      task({ id: "later", nextRunAt: new Date("2026-09-05T00:00:00Z") }),
      task({ id: "never" }),
      task({ id: "sooner", nextRunAt: new Date("2026-09-02T00:00:00Z") }),
    ])
    const result = (await run("schedule.list", { limit: 25 })) as { tasks: Array<{ id: string }> }
    expect(result.tasks.map((t) => t.id)).toEqual(["sooner", "later", "never"])
  })

  it("filters by status, type and search together", async () => {
    scheduler.getAllTasks.mockResolvedValue([
      task({ id: "a", status: "paused", type: "chat", name: "Digest" }),
      task({ id: "b", status: "active", type: "chat", name: "Digest" }),
      task({ id: "c", status: "paused", type: "goal", name: "Digest" }),
      task({ id: "d", status: "paused", type: "chat", name: "Something else" }),
    ])
    const result = (await run("schedule.list", {
      status: "paused",
      type: "chat",
      search: "dig",
      limit: 25,
    })) as { tasks: Array<{ id: string }>; total: number }
    expect(result.tasks.map((t) => t.id)).toEqual(["a"])
    expect(result.total).toBe(1)
  })

  it("reports the true total alongside the truncated page", async () => {
    scheduler.getAllTasks.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => task({ id: `t${i}` }))
    )
    const result = (await run("schedule.list", { limit: 2 })) as {
      total: number
      returned: number
    }
    expect(result).toMatchObject({ total: 5, returned: 2 })
  })

  it("is a read, so it never touches the policy gate", async () => {
    await run("schedule.list", { limit: 25 })
    expect(authorizeTaskWrite).not.toHaveBeenCalled()
  })
})
