/** @jest-environment jsdom */
/**
 * `schedule.stop_process`.
 *
 * The ownership check is the test that matters. Without it the verb would kill
 * any job on the host given its id, with the task id as decoration.
 */

const scheduler = { getTask: jest.fn() }
jest.mock("@/lib/scheduler/task-scheduler", () => ({ getTaskScheduler: () => scheduler }))

const authorizeTaskWrite = jest.fn()
jest.mock("@/lib/scheduler/write-authority", () => ({
  authorizeTaskWrite: (...args: unknown[]) => authorizeTaskWrite(...(args as [])),
  verdictNeedsConfirmation: (v: { allowed?: boolean; requiresConfirmation?: boolean }) =>
    Boolean(v?.allowed && v?.requiresConfirmation),
}))

const listTaskProcesses = jest.fn()
const killTaskJob = jest.fn()
const cancelTaskMonitor = jest.fn()
jest.mock("@/lib/scheduler/task-processes", () => ({
  listTaskProcesses: (...args: unknown[]) => listTaskProcesses(...(args as [])),
  killTaskJob: (...args: unknown[]) => killTaskJob(...(args as [])),
  cancelTaskMonitor: (...args: unknown[]) => cancelTaskMonitor(...(args as [])),
  taskTypeSpawnsProcesses: (type: string) => type === "background-command" || type === "monitor",
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkill, BuiltInSkillContext } from "../types"
import "./stop-process"

const registry = getSharedBuiltInSkillRegistry()
const ctx = { sessionId: "sess-1" } as BuiltInSkillContext

function skill(): BuiltInSkill {
  const found = registry.list().find((entry) => entry.id === "schedule.stop_process")
  if (!found) throw new Error("schedule.stop_process is not registered")
  return found
}

const run = (args: unknown) => skill().execute(args as never, ctx)

const TASK = {
  id: "task-1",
  name: "Nightly build",
  type: "background-command",
  status: "active",
  trigger: { type: "cron", cronExpression: "0 2 * * *" },
  runCount: 1,
  successCount: 1,
  failureCount: 0,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
}

beforeEach(() => {
  jest.clearAllMocks()
  authorizeTaskWrite.mockResolvedValue({ allowed: true })
  scheduler.getTask.mockResolvedValue(TASK)
  listTaskProcesses.mockResolvedValue({
    supported: true,
    jobs: [{ id: "job-1" }],
    monitors: [{ id: "mon-1" }],
  })
  killTaskJob.mockResolvedValue({ id: "job-1", status: "killed" })
  cancelTaskMonitor.mockResolvedValue({ id: "mon-1", status: "cancelled" })
})

it("kills a job the task actually owns", async () => {
  await expect(run({ taskId: "task-1", processId: "job-1", kind: "job" })).resolves.toMatchObject({
    status: "stopped",
    kind: "job",
    resultStatus: "killed",
  })
  expect(killTaskJob).toHaveBeenCalledWith("job-1")
})

it("stops a monitor without touching any job", async () => {
  await expect(
    run({ taskId: "task-1", processId: "mon-1", kind: "monitor" })
  ).resolves.toMatchObject({ status: "stopped", resultStatus: "cancelled" })
  expect(cancelTaskMonitor).toHaveBeenCalledWith("mon-1")
  expect(killTaskJob).not.toHaveBeenCalled()
})

// The whole reason ownership is re-checked here rather than trusted.
it("refuses to kill a job this task does not own", async () => {
  await expect(
    run({ taskId: "task-1", processId: "somebody-elses-job", kind: "job" })
  ).resolves.toMatchObject({ status: "not-found" })
  expect(killTaskJob).not.toHaveBeenCalled()
})

it("does not accept a monitor id as a job id", async () => {
  await expect(run({ taskId: "task-1", processId: "mon-1", kind: "job" })).resolves.toMatchObject({
    status: "not-found",
  })
  expect(killTaskJob).not.toHaveBeenCalled()
})

it("says a task type has no processes rather than searching for one", async () => {
  scheduler.getTask.mockResolvedValue({ ...TASK, type: "chat" })

  await expect(run({ taskId: "task-1", processId: "job-1", kind: "job" })).resolves.toMatchObject({
    status: "not-applicable",
  })
  expect(listTaskProcesses).not.toHaveBeenCalled()
})

it("reports a host that cannot answer instead of killing blind", async () => {
  listTaskProcesses.mockResolvedValue({ supported: false, reason: "No supervisor here." })

  await expect(run({ taskId: "task-1", processId: "job-1", kind: "job" })).resolves.toMatchObject({
    status: "unavailable",
  })
  expect(killTaskJob).not.toHaveBeenCalled()
})

it("passes the policy gate before doing anything", async () => {
  authorizeTaskWrite.mockResolvedValue({ allowed: false, message: "Not allowed." })

  await expect(run({ taskId: "task-1", processId: "job-1", kind: "job" })).rejects.toThrow(
    "Not allowed."
  )
  expect(listTaskProcesses).not.toHaveBeenCalled()
  expect(killTaskJob).not.toHaveBeenCalled()
})

it("is destructive and channel-opt-in, unlike cancelling a run", () => {
  // Killing a process leaves work part-way done with no record to inspect and
  // no way to resume, which cancelling a scheduled run does not.
  expect(skill().mutation).toBe("destructive")
  expect(skill().imAccess).toBe("opt-in")
})

it("warns about child processes in the confirm card for a job", () => {
  const surface = skill().hitlSurface?.(
    { taskId: "task-1", processId: "job-1", kind: "job" } as never,
    ctx
  )
  expect(JSON.stringify(surface)).toContain("child processes")
})
