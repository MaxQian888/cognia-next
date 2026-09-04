import type { ScheduledTask } from "@/types/scheduler"
import { describeOverrun, selectOverrunJobs, taskRuntimeLimitMs } from "./process-reaper"

const NOW = 1_000_000

type ReaperTask = Pick<ScheduledTask, "id" | "name" | "type" | "payload">

const task = (overrides: Partial<ReaperTask> = {}): ReaperTask =>
  ({
    id: "task-1",
    name: "Nightly build",
    type: "background-command",
    payload: { command: "pnpm build", cwd: "/repo", maxRuntimeMs: 60_000 },
    ...overrides,
  }) as ReaperTask

const job = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "job-1",
    command: "pnpm build",
    cwd: "/repo",
    owner: { kind: "scheduledTask", taskId: "task-1" },
    status: "running",
    startedAtMs: NOW - 120_000,
    totalOutputBytes: 0,
    droppedOutputBytes: 0,
    ...overrides,
  }) as never

const select = (jobs: unknown[], tasks: ReaperTask[] = [task()]) =>
  selectOverrunJobs({
    jobs: jobs as never,
    tasksById: new Map(tasks.map((t) => [t.id, t])),
    nowMs: NOW,
  })

describe("taskRuntimeLimitMs", () => {
  it("reads the limit off a background-command payload", () => {
    expect(taskRuntimeLimitMs(task())).toBe(60_000)
  })

  it("has no limit when the task did not set one", () => {
    expect(taskRuntimeLimitMs(task({ payload: { command: "x", cwd: "/" } }))).toBeUndefined()
  })

  // A monitor holds no CPU and already has `expiresAt`. Two expiry mechanisms
  // would be two answers to when a watch ends.
  it("has no limit for a monitor, which expires by its own field", () => {
    expect(taskRuntimeLimitMs(task({ type: "monitor" }))).toBeUndefined()
  })

  it.each([0, -1, Number.NaN, "60000", null])("ignores %p as a limit", (value) => {
    expect(
      taskRuntimeLimitMs(
        task({ payload: { command: "x", cwd: "/", maxRuntimeMs: value } as never })
      )
    ).toBeUndefined()
  })
})

describe("selectOverrunJobs", () => {
  it("selects a running job past its limit", () => {
    const overrun = select([job()])
    expect(overrun).toHaveLength(1)
    expect(overrun[0]).toMatchObject({
      jobId: "job-1",
      taskId: "task-1",
      taskName: "Nightly build",
      limitMs: 60_000,
      ranForMs: 120_000,
    })
  })

  it("leaves a job that is still inside its limit", () => {
    expect(select([job({ startedAtMs: NOW - 30_000 })])).toEqual([])
  })

  // Strictly greater, so a limit of exactly N does not race a process that was
  // about to exit cleanly at N.
  it("leaves a job sitting exactly on its limit", () => {
    expect(select([job({ startedAtMs: NOW - 60_000 })])).toEqual([])
  })

  it("leaves a job that is no longer running", () => {
    expect(select([job({ status: "exited" })])).toEqual([])
  })

  it("leaves a job whose task set no limit", () => {
    expect(select([job()], [task({ payload: { command: "x", cwd: "/" } })])).toEqual([])
  })

  // Deleting a task does not kill what it started, and inventing a limit for
  // an orphan would mean this sweep killing processes under a rule nobody set.
  it("leaves an orphan whose task is gone", () => {
    expect(select([job()], [])).toEqual([])
  })

  it("leaves jobs a session or the app owns", () => {
    expect(
      select([
        job({ owner: { kind: "session", sessionId: "task-1" } }),
        job({ owner: { kind: "app" } }),
      ])
    ).toEqual([])
  })

  it("selects across several tasks in one pass", () => {
    const other = task({ id: "task-2", name: "Nightly sync" })
    const overrun = select(
      [job(), job({ id: "job-2", owner: { kind: "scheduledTask", taskId: "task-2" } })],
      [task(), other]
    )
    expect(overrun.map((entry) => entry.jobId).sort()).toEqual(["job-1", "job-2"])
  })
})

describe("describeOverrun", () => {
  it("names how long it ran and the limit it passed", () => {
    const message = describeOverrun({
      jobId: "job-1",
      taskId: "task-1",
      taskName: "Nightly build",
      ranForMs: 120_000,
      limitMs: 60_000,
    })
    expect(message).toContain("120s")
    expect(message).toContain("60s")
  })
})
