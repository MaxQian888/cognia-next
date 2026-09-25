/** @jest-environment jsdom */
/**
 * `schedule.inspect`. Its reason to exist separate from `list` is the run
 * history, and specifically the terminal reason on each run.
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
const loadSchedulerPolicy = jest.fn(async () => ({ agentToolsEnabled: true }))
jest.mock("@/lib/scheduler/write-authority", () => ({
  loadSchedulerPolicy: () => loadSchedulerPolicy(),
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

describe("schedule.inspect", () => {
  it("surfaces the terminal reason, which is what explains a stuck task", async () => {
    scheduler.getTaskExecutions.mockResolvedValue([
      {
        id: "run-1",
        status: "failed",
        startedAt: new Date("2026-09-02T09:00:00Z"),
        terminalReason: "unsupported-on-host",
        error: "needs the desktop shell",
        retryAttempt: 0,
        logs: [],
      },
    ])
    const result = (await run("schedule.inspect", { taskId: "task-1", runLimit: 5 })) as {
      runs: Array<{ terminalReason?: string }>
    }
    expect(result.runs[0].terminalReason).toBe("unsupported-on-host")
  })

  it("skips the run query entirely when runLimit is 0", async () => {
    await run("schedule.inspect", { taskId: "task-1", runLimit: 0 })
    expect(scheduler.getTaskExecutions).not.toHaveBeenCalled()
  })

  it("names the id the agent passed when there is no such task", async () => {
    scheduler.getTask.mockResolvedValue(null)
    await expect(run("schedule.inspect", { taskId: "nope", runLimit: 5 })).rejects.toThrow(/nope/)
  })

  it("returns the payload and config a list row deliberately omits", async () => {
    scheduler.getTask.mockResolvedValue(task({ payload: { prompt: "hi" }, config: { timeout: 5 } }))
    const result = (await run("schedule.inspect", { taskId: "task-1", runLimit: 0 })) as {
      task: { payload?: unknown; config?: unknown }
    }
    expect(result.task.payload).toEqual({ prompt: "hi" })
    expect(result.task.config).toEqual({ timeout: 5 })
  })
})

describe("schedule.inspect · when next, and what a run produced", () => {
  it("lists the next three fire times of an active task", async () => {
    scheduler.getTask.mockResolvedValue(
      task({ trigger: { type: "interval", intervalMs: 3_600_000 } })
    )
    const out = (await run("schedule.inspect", { taskId: "task-1", runLimit: 0 })) as {
      task: { nextRuns?: string[] }
    }
    expect(out.task.nextRuns).toHaveLength(3)
    const [first, second] = out.task.nextRuns!.map((iso) => new Date(iso).getTime())
    expect(second - first).toBe(3_600_000)
  })

  it("has no next runs for a paused task", async () => {
    scheduler.getTask.mockResolvedValue(task({ status: "paused" }))
    const out = (await run("schedule.inspect", { taskId: "task-1", runLimit: 0 })) as {
      task: { nextRuns?: string[] }
    }
    expect(out.task.nextRuns).toBeUndefined()
  })

  it("points at the session a run produced", async () => {
    scheduler.getTaskExecutions.mockResolvedValue([
      {
        id: "run-1",
        taskId: "task-1",
        status: "completed",
        startedAt: new Date("2026-09-02T09:00:00Z"),
        output: { sessionId: "sess-run-1" },
      },
      {
        id: "run-2",
        taskId: "task-1",
        status: "failed",
        startedAt: new Date("2026-09-03T09:00:00Z"),
        error: "boom",
      },
    ])
    const out = (await run("schedule.inspect", { taskId: "task-1", runLimit: 5 })) as {
      runs: Array<{ id: string; links?: Array<{ kind: string; id: string }> }>
    }
    expect(out.runs[0].links).toEqual([{ kind: "session", id: "sess-run-1" }])
    expect(out.runs[1].links).toBeUndefined()
  })
})

describe("schedule.inspect · agent access", () => {
  it("refuses to read a task once agents may not manage the schedule", async () => {
    loadSchedulerPolicy.mockResolvedValueOnce({ agentToolsEnabled: false })
    await expect(run("schedule.inspect", { taskId: "task-1", runLimit: 0 })).rejects.toThrow(
      /not allowed to manage your schedule/
    )
    expect(scheduler.getTask).not.toHaveBeenCalled()
  })
})
