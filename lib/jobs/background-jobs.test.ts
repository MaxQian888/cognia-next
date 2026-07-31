import { transport } from "@/lib/tauri"
import {
  cancelBackgroundMonitor,
  killBackgroundJob,
  listBackgroundJobs,
  listBackgroundMonitors,
  readBackgroundJobTail,
  registerScheduledBackgroundMonitor,
  spawnScheduledBackgroundJob,
} from "./background-jobs"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

const invoke = jest.mocked(transport.call)

beforeEach(() => invoke.mockReset())

it("lists jobs and monitors through the active transport", async () => {
  invoke
    .mockResolvedValueOnce({ jobs: [{ id: "job-1" }] })
    .mockResolvedValueOnce({ monitors: [{ id: "monitor-1" }] })

  await expect(listBackgroundJobs()).resolves.toEqual([{ id: "job-1" }])
  await expect(listBackgroundMonitors()).resolves.toEqual([{ id: "monitor-1" }])
  expect(invoke).toHaveBeenNthCalledWith(1, "background_job_list", {})
  expect(invoke).toHaveBeenNthCalledWith(2, "background_monitor_list", {})
})

it("reads a bounded tail and clamps short logs to offset zero", async () => {
  invoke.mockResolvedValue({ data: "tail" })

  await readBackgroundJobTail({ id: "job-1", totalOutputBytes: 10_000 }, 2048)
  expect(invoke).toHaveBeenLastCalledWith("background_job_read", {
    jobId: "job-1",
    fromOffset: 7952,
    maxBytes: 2048,
  })

  await readBackgroundJobTail({ id: "job-2", totalOutputBytes: 12 }, 2048)
  expect(invoke).toHaveBeenLastCalledWith("background_job_read", {
    jobId: "job-2",
    fromOffset: 0,
    maxBytes: 2048,
  })
})

it("uses the explicit user-control commands for cancellation", async () => {
  invoke.mockResolvedValue({})
  await killBackgroundJob("job-1")
  await cancelBackgroundMonitor("monitor-1")

  expect(invoke).toHaveBeenNthCalledWith(1, "background_job_kill", { jobId: "job-1" })
  expect(invoke).toHaveBeenNthCalledWith(2, "background_monitor_cancel", {
    monitorId: "monitor-1",
  })
})

it("starts scheduler-owned jobs and monitors on the active host", async () => {
  invoke.mockResolvedValue({})
  await spawnScheduledBackgroundJob({
    taskId: "task-1",
    command: "pnpm build",
    cwd: "/workspace",
    label: "Nightly build",
  })
  await registerScheduledBackgroundMonitor({
    taskId: "task-2",
    condition: { kind: "jobExit", jobId: "job-1" },
    expiresAtMs: 123,
  })

  expect(invoke).toHaveBeenNthCalledWith(1, "background_job_spawn_scheduled", {
    taskId: "task-1",
    command: "pnpm build",
    cwd: "/workspace",
    label: "Nightly build",
  })
  expect(invoke).toHaveBeenNthCalledWith(2, "background_monitor_register_scheduled", {
    taskId: "task-2",
    condition: { kind: "jobExit", jobId: "job-1" },
    expiresAtMs: 123,
  })
})
