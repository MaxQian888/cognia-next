const listBackgroundJobs = jest.fn()
const listBackgroundMonitors = jest.fn()
const killBackgroundJob = jest.fn()
const cancelBackgroundMonitor = jest.fn()
jest.mock("@/lib/jobs/background-jobs", () => ({
  listBackgroundJobs: () => listBackgroundJobs(),
  listBackgroundMonitors: () => listBackgroundMonitors(),
  killBackgroundJob: (...args: unknown[]) => killBackgroundJob(...args),
  cancelBackgroundMonitor: (...args: unknown[]) => cancelBackgroundMonitor(...args),
}))

const getTaskTypeHostSupport = jest.fn()
jest.mock("./host-support", () => ({
  getTaskTypeHostSupport: (...args: unknown[]) => getTaskTypeHostSupport(...args),
}))

import {
  cancelTaskMonitor,
  countLiveProcesses,
  killTaskJob,
  listTaskProcesses,
  taskTypeSpawnsProcesses,
} from "./task-processes"

const job = (id: string, taskId: string, status = "running") => ({
  id,
  command: "pnpm build",
  cwd: "/repo",
  owner: { kind: "scheduledTask", taskId },
  status,
  startedAtMs: 1,
  totalOutputBytes: 0,
  droppedOutputBytes: 0,
})

const monitor = (id: string, taskId: string, status = "waiting") => ({
  id,
  condition: { kind: "jobExit", jobId: "j1" },
  owner: { kind: "scheduledTask", taskId },
  status,
  createdAtMs: 1,
})

beforeEach(() => {
  jest.clearAllMocks()
  getTaskTypeHostSupport.mockReturnValue({ supported: true })
  listBackgroundJobs.mockResolvedValue([])
  listBackgroundMonitors.mockResolvedValue([])
})

describe("taskTypeSpawnsProcesses", () => {
  it("names the two types that reach the process supervisor", () => {
    expect(taskTypeSpawnsProcesses("background-command")).toBe(true)
    expect(taskTypeSpawnsProcesses("monitor")).toBe(true)
  })

  it("excludes types that run in-process", () => {
    for (const type of ["chat", "agent", "workflow", "backup", "im-push"]) {
      expect(taskTypeSpawnsProcesses(type)).toBe(false)
    }
  })
})

describe("listTaskProcesses", () => {
  it("returns only what this task owns", async () => {
    listBackgroundJobs.mockResolvedValue([job("j1", "mine"), job("j2", "theirs")])
    listBackgroundMonitors.mockResolvedValue([monitor("m1", "theirs"), monitor("m2", "mine")])

    const result = await listTaskProcesses({ id: "mine", type: "background-command" })

    expect(result.supported).toBe(true)
    if (!result.supported) throw new Error("expected support")
    expect(result.jobs.map((j) => j.id)).toEqual(["j1"])
    expect(result.monitors.map((m) => m.id)).toEqual(["m2"])
  })

  it("ignores jobs owned by a session or by the app itself", async () => {
    listBackgroundJobs.mockResolvedValue([
      { ...job("j1", "mine"), owner: { kind: "session", sessionId: "mine" } },
      { ...job("j2", "mine"), owner: { kind: "app" } },
    ])

    const result = await listTaskProcesses({ id: "mine", type: "background-command" })
    if (!result.supported) throw new Error("expected support")
    // A session id that happens to equal a task id must not match.
    expect(result.jobs).toEqual([])
  })

  // The distinction this module exists for: on a phone, an empty list would
  // read as "the desktop's backup finished".
  it("reports a host with no supervisor as unsupported, not as empty", async () => {
    getTaskTypeHostSupport.mockReturnValue({ supported: false, reason: "missing-capability" })

    const result = await listTaskProcesses({ id: "mine", type: "background-command" })

    expect(result.supported).toBe(false)
    expect(listBackgroundJobs).not.toHaveBeenCalled()
  })

  it("reports a supervisor that does not answer as unsupported, not as empty", async () => {
    listBackgroundJobs.mockRejectedValue(new Error("no such command"))

    const result = await listTaskProcesses({ id: "mine", type: "background-command" })

    expect(result.supported).toBe(false)
    if (result.supported) throw new Error("expected a refusal")
    expect(result.reason).toMatch(/did not answer/)
  })
})

describe("countLiveProcesses", () => {
  it("counts only what is still holding something", () => {
    const processes = {
      supported: true as const,
      jobs: [job("j1", "t", "running"), job("j2", "t", "exited"), job("j3", "t", "killed")],
      monitors: [monitor("m1", "t", "waiting"), monitor("m2", "t", "fired")],
    }
    // Yesterday's exited run is not something the user can act on, and the row
    // it would inflate carries a kill button.
    expect(countLiveProcesses(processes as never)).toBe(2)
  })

  it("counts nothing on a host that cannot answer", () => {
    expect(countLiveProcesses({ supported: false, reason: "nope" })).toBe(0)
  })
})

describe("stopping", () => {
  it("kills a job by id", async () => {
    killBackgroundJob.mockResolvedValue({ id: "j1", status: "killed" })
    await expect(killTaskJob("j1")).resolves.toMatchObject({ status: "killed" })
    expect(killBackgroundJob).toHaveBeenCalledWith("j1")
  })

  it("cancels a monitor by id", async () => {
    cancelBackgroundMonitor.mockResolvedValue({ id: "m1", status: "cancelled" })
    await expect(cancelTaskMonitor("m1")).resolves.toMatchObject({ status: "cancelled" })
    expect(cancelBackgroundMonitor).toHaveBeenCalledWith("m1")
  })
})
