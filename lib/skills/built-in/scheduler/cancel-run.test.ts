/** @jest-environment jsdom */
/**
 * `schedule.cancel_run`.
 *
 * The refusals are the substance here. Each one is returned rather than
 * thrown, and each names a different next step, because "the run had already
 * finished" and "this host cannot reach it" are not the same news for the
 * assistant to relay.
 */

const scheduler = {
  getTask: jest.fn(),
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
import "./cancel-run"

const registry = getSharedBuiltInSkillRegistry()
const ctx = { sessionId: "sess-1" } as BuiltInSkillContext

function skill(): BuiltInSkill {
  const found = registry.list().find((entry) => entry.id === "schedule.cancel_run")
  if (!found) throw new Error("schedule.cancel_run is not registered")
  return found
}

function run(args: unknown): Promise<unknown> {
  return skill().execute(args as never, ctx)
}

const TASK = {
  id: "task-1",
  name: "Nightly backup",
  type: "backup",
  status: "active",
  trigger: { type: "cron", cronExpression: "0 2 * * *" },
  runCount: 4,
  successCount: 4,
  failureCount: 0,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
}

beforeEach(() => {
  jest.clearAllMocks()
  authorizeTaskWrite.mockResolvedValue({ allowed: true })
  scheduler.getTask.mockResolvedValue(TASK)
})

it("stops a running execution and names the task it belonged to", async () => {
  scheduler.cancelExecution.mockResolvedValue({ cancelled: true })

  await expect(run({ taskId: "task-1", runId: "run-9" })).resolves.toEqual({
    status: "cancelled",
    taskId: "task-1",
    taskName: "Nightly backup",
    runId: "run-9",
  })
  expect(scheduler.cancelExecution).toHaveBeenCalledWith("run-9")
})

it("asks the policy about the task before touching the run", async () => {
  scheduler.cancelExecution.mockResolvedValue({ cancelled: true })
  await run({ taskId: "task-1", runId: "run-9" })

  expect(authorizeTaskWrite).toHaveBeenCalledWith(
    expect.objectContaining({ taskType: "backup", source: "agent", sessionId: "sess-1" })
  )
})

it("refuses without cancelling when the policy says no", async () => {
  authorizeTaskWrite.mockResolvedValue({ allowed: false, message: "Agents may not do that." })

  await expect(run({ taskId: "task-1", runId: "run-9" })).rejects.toThrow("Agents may not do that.")
  expect(scheduler.cancelExecution).not.toHaveBeenCalled()
})

it("names an unknown task rather than reporting a missing run", async () => {
  scheduler.getTask.mockResolvedValue(null)

  await expect(run({ taskId: "nope", runId: "run-9" })).rejects.toThrow(/No scheduled task with id/)
  expect(scheduler.cancelExecution).not.toHaveBeenCalled()
})

describe("refusals are returned, not thrown", () => {
  it("reports a run that had already finished, with its status", async () => {
    scheduler.cancelExecution.mockResolvedValue({
      cancelled: false,
      reason: "already-settled",
      status: "completed",
    })

    await expect(run({ taskId: "task-1", runId: "run-9" })).resolves.toMatchObject({
      status: "already-finished",
      runStatus: "completed",
    })
  })

  it("reports an unknown run id and points at inspect", async () => {
    scheduler.cancelExecution.mockResolvedValue({ cancelled: false, reason: "not-found" })

    const result = (await run({ taskId: "task-1", runId: "ghost" })) as {
      status: string
      message: string
    }
    expect(result.status).toBe("not-found")
    expect(result.message).toContain("scheduler_inspect_task")
  })

  it("reports a request handed to another window as pending, not as done", async () => {
    scheduler.cancelExecution.mockResolvedValue({ cancelled: false, reason: "requested" })

    // The distinction that matters: the assistant must not tell the user the
    // run stopped when all that happened is a message was sent.
    await expect(run({ taskId: "task-1", runId: "run-9" })).resolves.toMatchObject({
      status: "requested",
    })
  })

  it("reports a paired host's run as unsupported and says where to go", async () => {
    scheduler.cancelExecution.mockResolvedValue({
      cancelled: false,
      reason: "unsupported-on-remote",
    })

    const result = (await run({ taskId: "task-1", runId: "run-9" })) as {
      status: string
      message: string
    }
    expect(result.status).toBe("unsupported")
    expect(result.message).toContain("scheduler panel")
  })

  it("reports a run nothing holds as unreachable", async () => {
    scheduler.cancelExecution.mockResolvedValue({ cancelled: false, reason: "not-owned-here" })

    await expect(run({ taskId: "task-1", runId: "run-9" })).resolves.toMatchObject({
      status: "unreachable",
    })
  })
})

it("carries a confirm card naming the run and the task", () => {
  const surface = skill().hitlSurface?.({ taskId: "task-1", runId: "run-9" } as never, ctx)
  expect(JSON.stringify(surface)).toContain("run-9")
})
