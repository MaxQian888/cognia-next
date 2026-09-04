/** @jest-environment jsdom */
/**
 * Family registration and tier assignments.
 *
 * The tiers are the part worth pinning in CI: `run_now` must not drift to
 * `read` merely because it stores no row, and `delete` must stay behind a
 * channel opt-in.
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
  cancelExecution: jest.fn(),
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

describe("the schedule family", () => {
  it("registers all nine skills under one family", () => {
    expect(
      registry
        .listByFamily("schedule")
        .map((s) => s.id)
        .sort()
    ).toEqual([
      "schedule.cancel_run",
      "schedule.create",
      "schedule.delete",
      "schedule.inspect",
      "schedule.list",
      "schedule.run_now",
      "schedule.set_status",
      "schedule.stop_process",
      "schedule.update",
    ])
  })

  it("classifies run_now as a write, not a read", () => {
    // It stores no row of its own, but it CAUSES the task's effects: an
    // im-push task sends a message, a background-command task runs a command.
    expect(skill("schedule.run_now").mutation).toBe("write")
  })

  it("classifies cancel_run as a write, for the mirror of run_now's reason", () => {
    // It stores no row either, and it abandons an agent turn or signals a
    // spawned process on the user's machine.
    expect(skill("schedule.cancel_run").mutation).toBe("write")
    // Stopping is the recoverable direction, so unlike delete it is not gated
    // behind a channel opt-in.
    expect(skill("schedule.cancel_run").imAccess).toBe("always")
  })

  it("keeps stop_process destructive, because a signalled process leaves work half-done", () => {
    // Cancelling a run records a cancelled execution and can be re-run.
    // Killing a process mid-write leaves whatever it was doing part-done with
    // nothing to inspect afterwards.
    expect(skill("schedule.stop_process").mutation).toBe("destructive")
    expect(skill("schedule.stop_process").imAccess).toBe("opt-in")
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

  it("names each skill's tool distinctly", () => {
    const names = registry.listByFamily("schedule").map((entry) => entry.mcpToolName)
    expect(new Set(names).size).toBe(names.length)
  })
})
