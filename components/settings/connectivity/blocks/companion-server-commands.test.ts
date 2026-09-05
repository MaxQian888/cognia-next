import {
  startServer,
  stopServer,
  transportInvoker,
  DEFAULT_PORT,
} from "./companion-server-commands"

const call = jest.fn()
jest.mock("@/lib/tauri", () => ({ transport: { call: (...args: unknown[]) => call(...args) } }))
jest.mock("@/lib/db/paired-devices", () => ({
  listPairedDevices: async () => [
    { deviceId: "a", allowRemoteControl: true, allowLockedComputerUse: true },
    { deviceId: "b", allowRemoteTerminal: true, revokedAt: 1 },
  ],
}))

describe("companion-server-commands", () => {
  beforeEach(() => call.mockReset().mockResolvedValue(27890))

  it("starts the server on the default port and replays the grant import", async () => {
    await expect(startServer("lan")).resolves.toBe(27890)
    expect(call).toHaveBeenNthCalledWith(1, "companion_server_start", {
      port: DEFAULT_PORT,
      bindLoopbackOnly: false,
    })
    expect(call).toHaveBeenCalledWith("companion_migrate_legacy_device_grants", {
      control: ["a"],
      agentControl: [],
      terminal: [],
    })
    expect(call).toHaveBeenCalledWith("companion_seed_locked_computer_use", { deviceIds: ["a"] })
  })

  it("stops the server and forwards argument-less invokes without a trailing undefined", async () => {
    await stopServer()
    expect(call).toHaveBeenCalledWith("companion_server_stop")
    const invoker = await transportInvoker()
    await invoker.invoke("companion_mdns_status")
    expect(call).toHaveBeenLastCalledWith("companion_mdns_status")
  })
})
