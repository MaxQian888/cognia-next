/**
 * @jest-environment jsdom
 */

let mockChain: string[] = []
jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockChain,
}))

jest.mock("@/lib/tauri", () => ({
  transport: { call: async () => undefined },
}))

import {
  readTerminalHostSettings,
  terminalHostReachable,
  writeTerminalHostSettings,
  type TerminalHostSettingsWire,
} from "./host-settings"

const SETTINGS: TerminalHostSettingsWire = {
  allowRemoteAccess: true,
  startAtLogin: false,
  diagnostics: false,
  maxSessions: 32,
  maxRemoteSessionsPerDevice: 8,
  replayBytesPerSession: 8 * 1024 * 1024,
  totalReplayBytes: 128 * 1024 * 1024,
}

beforeEach(() => {
  mockChain = []
})

describe("terminalHostReachable", () => {
  it("is false in web standalone, where there is no host to configure", () => {
    expect(terminalHostReachable()).toBe(false)
  })

  it("is true whenever some host can answer", () => {
    mockChain = ["ws", "webrtc"]
    expect(terminalHostReachable()).toBe(true)
    mockChain = ["tauri-channel"]
    expect(terminalHostReachable()).toBe(true)
  })
})

describe("readTerminalHostSettings", () => {
  it("asks the local command on the desktop", async () => {
    mockChain = ["tauri-channel"]
    const call = jest.fn(async () => ({ running: true, endpoint: "/sock", settings: SETTINGS }))
    await expect(readTerminalHostSettings(call as never)).resolves.toEqual(SETTINGS)
    expect(call).toHaveBeenCalledWith("terminal_host_service", { action: { kind: "status" } })
  })

  it("asks the companion RPC against a remote host", async () => {
    mockChain = ["ws"]
    const call = jest.fn(async () => ({ running: true, endpoint: "/sock", settings: SETTINGS }))
    await expect(readTerminalHostSettings(call as never)).resolves.toEqual(SETTINGS)
    expect(call).toHaveBeenCalledWith("terminal_host_status", {})
  })

  it("does not ask at all when there is no host", async () => {
    const call = jest.fn(async () => ({}) as never)
    await expect(readTerminalHostSettings(call as never)).resolves.toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  // The caller renders the mirror when this returns null. Throwing would take
  // the settings page down over a host that merely happens to be offline.
  it("reports an unreachable host as unknown rather than throwing", async () => {
    mockChain = ["ws"]
    const call = jest.fn(async () => {
      throw new Error("host offline")
    })
    await expect(readTerminalHostSettings(call as never)).resolves.toBeNull()
  })
})

describe("writeTerminalHostSettings", () => {
  it("configures through the local command on the desktop", async () => {
    mockChain = ["tauri-channel"]
    const call = jest.fn(async () => undefined)
    await writeTerminalHostSettings(SETTINGS, call as never)
    expect(call).toHaveBeenCalledWith("terminal_host_service", {
      action: { kind: "configure", settings: SETTINGS },
    })
  })

  it("configures through the host.admin RPC against a remote host", async () => {
    mockChain = ["webrtc"]
    const call = jest.fn(async () => undefined)
    await writeTerminalHostSettings(SETTINGS, call as never)
    expect(call).toHaveBeenCalledWith("terminal_host_configure", { settings: SETTINGS })
  })

  // Must throw, not resolve: the caller mirrors the change locally on success,
  // and a silent no-op is exactly the switch-that-lies this module replaced.
  it("refuses rather than pretending when there is no host", async () => {
    const call = jest.fn(async () => undefined)
    await expect(writeTerminalHostSettings(SETTINGS, call as never)).rejects.toThrow(
      /no terminal host/i
    )
    expect(call).not.toHaveBeenCalled()
  })

  it("propagates a host refusal", async () => {
    mockChain = ["ws"]
    const call = jest.fn(async () => {
      throw new Error("missing_capability")
    })
    await expect(writeTerminalHostSettings(SETTINGS, call as never)).rejects.toThrow(
      "missing_capability"
    )
  })
})
