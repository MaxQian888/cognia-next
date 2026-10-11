/** @jest-environment jsdom */
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import { closeManagementChannel } from "@/lib/remote-host/management-channel"

import {
  HostUpdateUnsupportedError,
  canInstallHostUpdate,
  configureHostUpdate,
  installHostUpdate,
  isHostUpdateInFlight,
  readHostUpdateStatus,
  refreshHostUpdate,
  type HostUpdateDeps,
  type HostUpdateStatus,
} from "./host-update"

const HOST = "host-update-test"
const call = jest.fn()

function deps(): HostUpdateDeps {
  return {
    channel: {
      openTarget: async () =>
        ({
          host: { id: HOST, label: "Mac mini" },
          transport: { call, subscribe: jest.fn(() => () => undefined) },
          close: jest.fn(),
        }) as unknown as RemoteHostTarget,
    },
  }
}

const status = (overrides: Partial<HostUpdateStatus> = {}): HostUpdateStatus => ({
  install: "native",
  currentVersion: "1.4.0",
  channel: "stable",
  autoUpdate: true,
  phase: "available",
  available: { version: "1.5.0", criticality: "routine" },
  installRequested: false,
  ...overrides,
})

beforeEach(() => call.mockReset())
afterEach(() => closeManagementChannel(HOST))

describe("host updates over the management channel", () => {
  it("names each command and passes only what changes", async () => {
    call.mockResolvedValue(status())
    await readHostUpdateStatus(HOST, deps())
    await refreshHostUpdate(HOST, deps())
    await configureHostUpdate(HOST, { channel: "beta" }, deps())
    await installHostUpdate(HOST, deps())
    expect(call.mock.calls).toEqual([
      ["host_update_status", {}],
      ["host_update_refresh", {}],
      ["host_update_configure", { channel: "beta" }],
      ["host_update_install", {}],
    ])
  })

  it("reports a host from before self-update as one to update by hand", async () => {
    call.mockRejectedValue(Object.assign(new Error("unknown"), { code: "unknown_command" }))
    await expect(readHostUpdateStatus(HOST, deps())).rejects.toBeInstanceOf(
      HostUpdateUnsupportedError
    )
    const refused = Object.assign(new Error("busy"), { code: "host_update_refused" })
    call.mockRejectedValue(refused)
    await expect(installHostUpdate(HOST, deps())).rejects.toBe(refused)
  })
})

describe("what the status allows", () => {
  it("offers an update only on a managed host with a release and nothing under way", () => {
    expect(canInstallHostUpdate(status())).toBe(true)
    expect(canInstallHostUpdate(status({ available: undefined, phase: "idle" }))).toBe(false)
    expect(canInstallHostUpdate(status({ install: "unmanaged" }))).toBe(false)
    expect(canInstallHostUpdate(status({ installRequested: true }))).toBe(false)
    expect(canInstallHostUpdate(status({ phase: "downloading" }))).toBe(false)
  })

  it("treats every moving phase as in flight", () => {
    for (const phase of [
      "checking",
      "waiting-for-idle",
      "downloading",
      "installing",
      "restarting",
      "trial",
    ] as const) {
      expect(isHostUpdateInFlight(status({ phase }))).toBe(true)
    }
    expect(isHostUpdateInFlight(status({ phase: "idle" }))).toBe(false)
    expect(isHostUpdateInFlight(status({ phase: "available" }))).toBe(false)
  })
})
