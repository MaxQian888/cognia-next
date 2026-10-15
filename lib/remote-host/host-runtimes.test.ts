/** @jest-environment jsdom */
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import { closeManagementChannel } from "@/lib/remote-host/management-channel"

import {
  failedHostRuntimes,
  HostRuntimesUnavailableError,
  readHostRuntimes,
  restartHostRuntime,
  type HostRuntime,
} from "./host-runtimes"

const HOST = "host-runtimes-test"
const call = jest.fn()

function deps() {
  return {
    channel: {
      openTarget: async () =>
        ({
          host: { id: HOST, label: "Cognia云主机" },
          transport: { call, subscribe: jest.fn(() => () => undefined) },
          close: jest.fn(),
        }) as unknown as RemoteHostTarget,
    },
  }
}

const running: HostRuntime = { name: "bots", state: "running", restartable: true, restarts: 0 }
const failed: HostRuntime = {
  name: "room-runner",
  state: "failed",
  error: "no backend",
  restartable: true,
  restarts: 0,
}

beforeEach(() => call.mockReset())
afterEach(() => closeManagementChannel(HOST))

it("reads the runtimes over the host's management channel", async () => {
  call.mockResolvedValue({ runtimes: [running, failed] })
  await expect(readHostRuntimes(HOST, deps())).resolves.toEqual({ runtimes: [running, failed] })
  expect(call).toHaveBeenCalledWith("host_runtime_status", {})
})

it("restarts one runtime by name", async () => {
  call.mockResolvedValue({ runtime: { ...failed, state: "running" }, runtimes: [running] })
  await expect(restartHostRuntime(HOST, "room-runner", deps())).resolves.toMatchObject({
    runtime: { name: "room-runner", state: "running" },
  })
  expect(call).toHaveBeenCalledWith("host_runtime_restart", { name: "room-runner" })
})

it("says why a host cannot report runtimes, and passes other errors through", async () => {
  call.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "unknown_command" }))
  await expect(readHostRuntimes(HOST, deps())).rejects.toEqual(
    new HostRuntimesUnavailableError("outdated")
  )
  call.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "headless_host_required" }))
  await expect(readHostRuntimes(HOST, deps())).rejects.toMatchObject({ reason: "not-headless" })
  const refused = Object.assign(new Error("no teardown"), { code: "runtime_not_restartable" })
  call.mockRejectedValueOnce(refused)
  await expect(restartHostRuntime(HOST, "bots", deps())).rejects.toBe(refused)
})

it("picks out the runtimes that failed", () => {
  expect(failedHostRuntimes([running, failed])).toEqual([failed])
})

it("preserves criticality from current hosts and accepts legacy responses without it", async () => {
  const required = { ...failed, criticality: "required" as const }
  const optional = { ...running, criticality: "optional" as const }
  call.mockResolvedValue({ runtimes: [required, optional, failed] })
  const result = await readHostRuntimes(HOST, deps())
  expect(result.runtimes.map((runtime) => runtime.criticality)).toEqual([
    "required",
    "optional",
    undefined,
  ])
})
