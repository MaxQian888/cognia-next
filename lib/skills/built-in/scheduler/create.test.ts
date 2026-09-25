/** @jest-environment jsdom */
/**
 * `schedule.create`. The write this whole family exists for, so most of what
 * matters is what it refuses and what it puts on the confirmation card.
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

describe("schedule.create · preflight and confirmation", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString()
  function preflight(args: Record<string, unknown>, humanConfirmed = true) {
    return skill("schedule.create").preflight!(args as never, { ...ctx, humanConfirmed })
  }

  it("rejects an unparseable cron before the user is asked", async () => {
    await expect(
      preflight({
        name: "n",
        type: "chat",
        trigger: { type: "cron", cronExpression: "every morning" },
        payload: { prompt: "hi" },
      })
    ).rejects.toThrow()
    expect(authorizeTaskWrite).not.toHaveBeenCalled()
  })

  it("rejects a one-off time already in the past", async () => {
    await expect(
      preflight({
        name: "n",
        type: "chat",
        trigger: { type: "once", runAt: "2020-01-01T00:00:00Z" },
        payload: { prompt: "hi" },
      })
    ).rejects.toThrow(/future/)
  })

  it("rejects a payload the executor would reject", async () => {
    await expect(
      preflight({
        name: "n",
        type: "agent",
        trigger: { type: "once", runAt: future },
        payload: { prompt: "hi" },
      })
    ).rejects.toThrow(/characterId/)
    await expect(
      preflight({
        name: "n",
        type: "workflow",
        trigger: { type: "once", runAt: future },
        payload: {},
      })
    ).rejects.toThrow(/workflowId/)
  })

  it("asks the policy with the confirmation that is coming, as a create", async () => {
    await preflight({
      name: "n",
      type: "chat",
      trigger: { type: "cron", cronExpression: "0 9 * * 1-5" },
      payload: { prompt: "hi" },
    })
    expect(authorizeTaskWrite).toHaveBeenCalledWith(
      expect.objectContaining({ source: "agent", operation: "create", humanConfirmed: true })
    )
  })

  it("surfaces a policy refusal in preflight, so no dialog is shown for it", async () => {
    authorizeTaskWrite.mockResolvedValue({
      allowed: false,
      reason: "agent-tools-disabled",
      message: "Agents are not allowed to manage your schedule.",
    })
    await expect(
      preflight({
        name: "n",
        type: "chat",
        trigger: { type: "interval", intervalMs: 60_000 },
        payload: { prompt: "hi" },
      })
    ).rejects.toThrow(/not allowed to manage/)
  })

  it("executes a confirmed write with humanConfirmed, which the policy counts", async () => {
    scheduler.createTask.mockResolvedValue(task())
    await skill("schedule.create").execute(
      {
        name: "n",
        type: "chat",
        trigger: { type: "interval", intervalMs: 60_000 },
        payload: { prompt: "hi" },
        paused: false,
      } as never,
      { ...ctx, humanConfirmed: true }
    )
    expect(authorizeTaskWrite).toHaveBeenCalledWith(
      expect.objectContaining({ humanConfirmed: true, operation: "create" })
    )
    expect(scheduler.createTask).toHaveBeenCalled()
  })

  it("refuses an unattended write the policy says needs a person", async () => {
    authorizeTaskWrite.mockResolvedValue({
      allowed: true,
      requiresConfirmation: true,
      reason: "confirmation-required",
      message: 'Scheduling a "goal" task needs your confirmation.',
    })
    await expect(
      skill("schedule.create").execute(
        {
          name: "n",
          type: "goal",
          trigger: { type: "interval", intervalMs: 60_000 },
          payload: { objective: "x" },
          paused: false,
        } as never,
        { ...ctx, humanConfirmed: false }
      )
    ).rejects.toThrow(/did not ask you to confirm/)
    expect(scheduler.createTask).not.toHaveBeenCalled()
  })
})
