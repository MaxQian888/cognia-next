/**
 * @jest-environment jsdom
 */
/**
 * The `schedule.*` family.
 *
 * Two things are worth pinning beyond "the call reaches the scheduler". First,
 * that every write consults the user's policy, because the whole family exists
 * on top of a gate that used to be decorative. Second, the tier assignments:
 * `run_now` must not be classified `read` merely because it stores no row, and
 * `delete` must stay `destructive` and opt-in.
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
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => scheduler,
}))

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

describe("family registration", () => {
  it("registers all seven skills under one family", () => {
    expect(
      registry
        .listByFamily("schedule")
        .map((s) => s.id)
        .sort()
    ).toEqual([
      "schedule.create",
      "schedule.delete",
      "schedule.inspect",
      "schedule.list",
      "schedule.run_now",
      "schedule.set_status",
      "schedule.update",
    ])
  })

  it("classifies run_now as a write, not a read", () => {
    // It stores no row of its own, but it CAUSES the task's effects: an
    // im-push task sends a message, a background-command task runs a command.
    expect(skill("schedule.run_now").mutation).toBe("write")
    expect(skill("schedule.run_now").hitlSurface).toBeDefined()
  })

  it("keeps delete destructive and behind a channel opt-in", () => {
    // The only irreversible verb in the family.
    expect(skill("schedule.delete").mutation).toBe("destructive")
    expect(skill("schedule.delete").imAccess).toBe("opt-in")
  })

  it("gives every non-read skill a confirm card", () => {
    // The dispatcher refuses to register a write without one, but that refusal
    // happens at runtime. This fails in CI instead.
    for (const entry of registry.listByFamily("schedule")) {
      if (entry.mutation === "read") continue
      expect(entry.hitlSurface).toBeDefined()
    }
  })
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
})

describe("schedule.create", () => {
  it("stamps agent provenance carrying the owning session", async () => {
    scheduler.createTask.mockResolvedValue(task())
    await run("schedule.create", {
      name: "n",
      type: "goal",
      trigger: { type: "cron", cronExpression: "0 9 * * *" },
      payload: { objective: "tidy the inbox" },
      paused: false,
    })
    expect(scheduler.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "goal",
        createdBy: { kind: "agent", sessionId: "sess-1" },
      })
    )
  })

  it("refuses when the user's policy says no, without writing", async () => {
    authorizeTaskWrite.mockResolvedValue({
      allowed: false,
      reason: "agent-auto-create-disabled",
      message: "Agents are not allowed to add to your schedule on their own.",
    })
    await expect(
      run("schedule.create", {
        name: "n",
        type: "chat",
        trigger: { type: "interval", intervalMs: 60_000 },
        payload: { prompt: "hi" },
        paused: false,
      })
    ).rejects.toThrow(/not allowed/)
    expect(scheduler.createTask).not.toHaveBeenCalled()
  })

  it("supports a one-off run, which the legacy tools could not express", async () => {
    // Before this family, "do X tomorrow at 9" had to become a cron that then
    // repeated every day.
    scheduler.createTask.mockResolvedValue(task())
    await run("schedule.create", {
      name: "n",
      type: "chat",
      trigger: { type: "once", runAt: "2026-09-05T09:00:00.000Z" },
      payload: { prompt: "hi" },
      paused: false,
    })
    expect(scheduler.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { type: "once", runAt: new Date("2026-09-05T09:00:00.000Z") },
      })
    )
  })

  it("rejects an unparseable one-off instant rather than scheduling at epoch", async () => {
    await expect(
      run("schedule.create", {
        name: "n",
        type: "chat",
        trigger: { type: "once", runAt: "next tuesday" },
        payload: { prompt: "hi" },
        paused: false,
      })
    ).rejects.toThrow(/ISO-8601/)
    expect(scheduler.createTask).not.toHaveBeenCalled()
  })

  it("can create paused, for a task the user wants to review first", async () => {
    scheduler.createTask.mockResolvedValue(task({ status: "paused" }))
    await run("schedule.create", {
      name: "n",
      type: "chat",
      trigger: { type: "interval", intervalMs: 60_000 },
      payload: { prompt: "hi" },
      paused: true,
    })
    expect(scheduler.createTask).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }))
  })

  it("puts what will actually run on the confirmation card", async () => {
    const surface = skill("schedule.create").hitlSurface!({
      name: "Morning digest",
      type: "chat",
      trigger: { type: "cron", cronExpression: "0 9 * * *" },
      payload: { prompt: "summarise my inbox" },
      paused: false,
    } as never)
    const rendered = JSON.stringify(surface)
    expect(rendered).toContain("Morning digest")
    expect(rendered).toContain("0 9 * * *")
    // A card that hides the payload is not a confirmation of anything.
    expect(rendered).toContain("summarise my inbox")
  })
})

describe("schedule.update", () => {
  it("changes only the fields supplied", async () => {
    scheduler.updateTask.mockResolvedValue(task({ name: "Renamed" }))
    await run("schedule.update", { taskId: "task-1", name: "Renamed" })
    expect(scheduler.updateTask).toHaveBeenCalledWith("task-1", { name: "Renamed" })
  })

  it("gates on the existing type, which it cannot change", async () => {
    scheduler.getTask.mockResolvedValue(task({ type: "background-command" }))
    scheduler.updateTask.mockResolvedValue(task({ type: "background-command" }))
    await run("schedule.update", { taskId: "task-1", name: "Renamed" })
    expect(authorizeTaskWrite).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "background-command" })
    )
  })
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
    expect(scheduler.runTaskNow).toHaveBeenCalledWith("task-1", { triggerSource: "run-now" })
    expect(scheduler.updateTask).not.toHaveBeenCalled()
    expect(result.runId).toBe("run-9")
  })
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
})
