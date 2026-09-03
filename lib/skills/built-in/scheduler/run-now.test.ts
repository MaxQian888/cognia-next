/** @jest-environment jsdom */
/**
 * `schedule.run_now`. Runs the task without disturbing its schedule, which is
 * what makes it the honest way to check a cron actually works.
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

describe("schedule.run_now", () => {
  it("runs without touching the schedule, and marks the run as manual", async () => {
    scheduler.runTaskNow.mockResolvedValue({
      id: "run-9",
      status: "completed",
      startedAt: new Date("2026-09-03T10:00:00Z"),
      retryAttempt: 0,
      logs: [],
    })
    const result = (await run("schedule.run_now", { taskId: "task-1" })) as { runId: string }
    // The trigger source is what lets the history distinguish a manual run
    // from one the clock started, which is the whole point of running it here.
    expect(scheduler.runTaskNow).toHaveBeenCalledWith("task-1", { triggerSource: "run-now" })
    expect(scheduler.updateTask).not.toHaveBeenCalled()
    expect(result.runId).toBe("run-9")
  })

  it("asks the policy first, because it causes the task's effects", async () => {
    authorizeTaskWrite.mockResolvedValue({
      allowed: false,
      reason: "quota-exceeded",
      message: "limit reached",
    })
    await expect(run("schedule.run_now", { taskId: "task-1" })).rejects.toThrow("limit reached")
    expect(scheduler.runTaskNow).not.toHaveBeenCalled()
  })

  it("carries the terminal reason back when the run fails", async () => {
    scheduler.runTaskNow.mockResolvedValue({
      id: "run-9",
      status: "failed",
      startedAt: new Date("2026-09-03T10:00:00Z"),
      terminalReason: "unsupported-on-host",
      error: "needs the desktop shell",
      retryAttempt: 0,
      logs: [],
    })
    const result = (await run("schedule.run_now", { taskId: "task-1" })) as {
      terminalReason?: string
    }
    expect(result.terminalReason).toBe("unsupported-on-host")
  })

  it("says so when the scheduler did not start it at all", async () => {
    scheduler.runTaskNow.mockResolvedValue(null)
    await expect(run("schedule.run_now", { taskId: "task-1" })).rejects.toThrow(/task-1/)
  })
})
