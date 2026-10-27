import { transport } from "@/lib/tauri"
import { getCompanionConfigGeneration } from "@/lib/tauri/transport-companion"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import {
  bridgeJobOwner,
  cancelBackgroundMonitor,
  chatShellJobOwner,
  killBackgroundJob,
  listBackgroundJobs,
  listBackgroundMonitors,
  readBackgroundJobOutput,
  readBackgroundJobTail,
  registerScheduledBackgroundMonitor,
  spawnBridgeBackgroundJob,
  spawnScheduledBackgroundJob,
  spawnSessionBackgroundJob,
  waitBackgroundJobOutput,
} from "./background-jobs"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))
jest.mock("@/lib/tauri/transport-companion", () => ({ getCompanionConfigGeneration: jest.fn() }))
jest.mock("@/lib/tauri/transport-routing", () => ({ getActiveRemoteTransport: jest.fn() }))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(),
}))

const invoke = jest.mocked(transport.call)

let pairingGeneration = 0
beforeEach(() => {
  invoke.mockReset()
  jest.mocked(getCompanionConfigGeneration).mockReturnValue(++pairingGeneration)
  jest.mocked(getActiveRemoteTransport).mockReturnValue(null)
  jest
    .mocked(getActiveRuntimeTargetContext)
    .mockReturnValue({ accountId: "ada", targetId: "host", routingGeneration: 1 })
})

it.each([listBackgroundJobs, listBackgroundMonitors])(
  "stops asking a refused list across later turns and retries after pairing changes (%#)",
  async (list) => {
    const refusal = Object.assign(new Error("host_surface_forbidden"), { retryable: false })
    invoke.mockRejectedValue(refusal)
    await expect(list()).rejects.toBe(refusal)
    await expect(list()).rejects.toBe(refusal)
    expect(invoke).toHaveBeenCalledTimes(1)
    jest.mocked(getCompanionConfigGeneration).mockReturnValue(++pairingGeneration)
    await expect(list()).rejects.toBe(refusal)
    expect(invoke).toHaveBeenCalledTimes(2)
  }
)

it("keeps list refusals independent and retries transient failures", async () => {
  const refusal = Object.assign(new Error("forbidden"), { retryable: false })
  invoke.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ monitors: [] })
  await expect(listBackgroundJobs()).rejects.toBe(refusal)
  await expect(listBackgroundMonitors()).resolves.toEqual([])
  const transient = Object.assign(new Error("unavailable"), { retryable: true })
  invoke.mockRejectedValueOnce(transient).mockResolvedValueOnce({ monitors: [] })
  await expect(listBackgroundMonitors()).rejects.toBe(transient)
  await expect(listBackgroundMonitors()).resolves.toEqual([])
  expect(invoke).toHaveBeenCalledTimes(4)
})

it("retries a final refusal when the account, target, or remote transport changes", async () => {
  const refusal = Object.assign(new Error("forbidden"), { retryable: false })
  invoke.mockRejectedValue(refusal)
  await expect(listBackgroundJobs()).rejects.toBe(refusal)
  jest
    .mocked(getActiveRuntimeTargetContext)
    .mockReturnValue({ accountId: "bob", targetId: "host", routingGeneration: 2 })
  await expect(listBackgroundJobs()).rejects.toBe(refusal)
  jest
    .mocked(getActiveRuntimeTargetContext)
    .mockReturnValue({ accountId: "bob", targetId: "other", routingGeneration: 3 })
  await expect(listBackgroundJobs()).rejects.toBe(refusal)
  jest.mocked(getActiveRemoteTransport).mockReturnValue({ call: jest.fn(), subscribe: jest.fn() })
  await expect(listBackgroundJobs()).rejects.toBe(refusal)
  expect(invoke).toHaveBeenCalledTimes(4)
})

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

it("reads output from an absolute offset and clamps negative offsets to zero", async () => {
  invoke.mockResolvedValue({ data: "chunk", nextOffset: 10, hasMore: false, status: "running" })

  await expect(readBackgroundJobOutput("job-1", 5, 4096)).resolves.toMatchObject({ data: "chunk" })
  expect(invoke).toHaveBeenLastCalledWith("background_job_read", {
    jobId: "job-1",
    fromOffset: 5,
    maxBytes: 4096,
  })

  await readBackgroundJobOutput("job-1", -3)
  expect(invoke).toHaveBeenLastCalledWith("background_job_read", {
    jobId: "job-1",
    fromOffset: 0,
    maxBytes: 8192,
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

describe("External Bridge jobs", () => {
  it("lists only one owner's jobs when an owner is given", async () => {
    invoke.mockResolvedValueOnce({ jobs: [] })
    await listBackgroundJobs(bridgeJobOwner("mcp:client-1"))
    expect(invoke).toHaveBeenCalledWith("background_job_list", {
      owner: { kind: "session", sessionId: "external-bridge:jobs:mcp:client-1" },
    })
  })

  it("spawns under the bridge command with the client id", async () => {
    invoke.mockResolvedValueOnce({ id: "job-9" })
    await spawnBridgeBackgroundJob({
      clientId: "mcp:stdio",
      command: "pnpm test",
      cwd: "/repo",
      label: "pnpm",
    })
    expect(invoke).toHaveBeenCalledWith("background_job_spawn_bridge", {
      clientId: "mcp:stdio",
      command: "pnpm test",
      cwd: "/repo",
      label: "pnpm",
    })
  })

  it("long-polls output with a clamped offset and defaults", async () => {
    invoke.mockResolvedValue({ data: "" })
    await waitBackgroundJobOutput("job-1", -5)
    expect(invoke).toHaveBeenLastCalledWith("background_job_wait", {
      jobId: "job-1",
      fromOffset: 0,
      maxBytes: 8192,
      waitMs: 0,
    })
    await waitBackgroundJobOutput("job-1", 12, { maxBytes: 100, waitMs: 5000 })
    expect(invoke).toHaveBeenLastCalledWith("background_job_wait", {
      jobId: "job-1",
      fromOffset: 12,
      maxBytes: 100,
      waitMs: 5000,
    })
  })
})

it("spawns a session job with explicit argv and files it under the chat-shell owner", async () => {
  invoke.mockResolvedValue({ id: "job-9" })

  await spawnSessionBackgroundJob({
    sessionId: "sess-1",
    command: "pnpm build",
    program: "/bin/zsh",
    args: ["-lc", "pnpm build"],
    cwd: "/work",
    label: "Chat command",
  })
  expect(invoke).toHaveBeenLastCalledWith("background_job_spawn_session", {
    sessionId: "sess-1",
    command: "pnpm build",
    program: "/bin/zsh",
    args: ["-lc", "pnpm build"],
    cwd: "/work",
    label: "Chat command",
  })
  expect(chatShellJobOwner("sess-1")).toEqual({
    kind: "session",
    sessionId: "chat-shell:sess-1",
  })
})

it("sends an admin lease only when one was issued", async () => {
  invoke.mockResolvedValue({ id: "job-9" })

  await spawnSessionBackgroundJob({
    sessionId: "sess-1",
    command: "ls",
    program: "/bin/sh",
    args: ["-lc", "ls"],
    cwd: "/work",
    adminLease: "lease-1",
  })
  expect(invoke).toHaveBeenLastCalledWith(
    "background_job_spawn_session",
    expect.objectContaining({ adminLease: "lease-1" })
  )
})
