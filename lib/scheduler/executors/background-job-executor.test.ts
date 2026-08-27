import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import {
  registerScheduledBackgroundMonitor,
  spawnScheduledBackgroundJob,
} from "@/lib/jobs/background-jobs"
import { executeBackgroundCommandTask, executeMonitorTask } from "./background-job-executor"

const hostIsTauriMock = jest.fn(() => true)
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => (hostIsTauriMock() ? "tauri" : "web"),
  isTauri: () => hostIsTauriMock(),
}))

jest.mock("@/lib/jobs/background-jobs", () => ({
  spawnScheduledBackgroundJob: jest.fn(),
  registerScheduledBackgroundMonitor: jest.fn(),
}))

const spawn = jest.mocked(spawnScheduledBackgroundJob)
const register = jest.mocked(registerScheduledBackgroundMonitor)
const task = (type: ScheduledTask["type"], payload: ScheduledTask["payload"]) =>
  ({ id: "task-1", name: "Nightly", type, payload }) as ScheduledTask
const execution = {} as TaskExecution

beforeEach(() => {
  hostIsTauriMock.mockReturnValue(true)
  spawn.mockReset()
  register.mockReset()
})

it("starts a scheduled-task-owned background command", async () => {
  spawn.mockResolvedValue({
    id: "job-1",
    status: "running",
    owner: { kind: "scheduledTask", taskId: "task-1" },
  } as Awaited<ReturnType<typeof spawnScheduledBackgroundJob>>)

  await expect(
    executeBackgroundCommandTask(
      task("background-command", { command: "pnpm build", cwd: "/workspace" }),
      execution,
      new AbortController().signal
    )
  ).resolves.toEqual(
    expect.objectContaining({ success: true, output: expect.objectContaining({ jobId: "job-1" }) })
  )
  expect(spawn).toHaveBeenCalledWith({
    taskId: "task-1",
    command: "pnpm build",
    cwd: "/workspace",
    label: "Nightly",
  })
})

it("registers a durable monitor and validates inputs before invoking", async () => {
  register.mockResolvedValue({
    id: "monitor-1",
    status: "waiting",
    owner: { kind: "scheduledTask", taskId: "task-1" },
  } as Awaited<ReturnType<typeof registerScheduledBackgroundMonitor>>)

  await expect(
    executeMonitorTask(
      task("monitor", {
        condition: { kind: "jobExit", jobId: "job-1" },
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      execution,
      new AbortController().signal
    )
  ).resolves.toEqual(
    expect.objectContaining({
      success: true,
      output: expect.objectContaining({ monitorId: "monitor-1" }),
    })
  )

  await expect(
    executeBackgroundCommandTask(
      task("background-command", { command: "", cwd: "" }),
      execution,
      new AbortController().signal
    )
  ).resolves.toEqual(expect.objectContaining({ success: false }))
  await expect(
    executeMonitorTask(
      task("monitor", { condition: { kind: "jobExit", jobId: "job-1" }, expiresAt: "bad" }),
      execution,
      new AbortController().signal
    )
  ).resolves.toEqual(expect.objectContaining({ success: false }))
  expect(spawn).not.toHaveBeenCalled()
  expect(register).toHaveBeenCalledTimes(1)
})

it("refuses both job types on a host with no shell", async () => {
  hostIsTauriMock.mockReturnValue(false)
  const command = await executeBackgroundCommandTask(
    task("background-command", { command: "pnpm build", cwd: "/repo" }),
    execution,
    new AbortController().signal
  )
  const monitor = await executeMonitorTask(
    task("monitor", { condition: { kind: "file-exists", path: "/tmp/x" } }),
    execution,
    new AbortController().signal
  )
  expect(command.terminalReason).toBe("unsupported-on-host")
  expect(monitor.terminalReason).toBe("unsupported-on-host")
  expect(spawn).not.toHaveBeenCalled()
  expect(register).not.toHaveBeenCalled()
})
