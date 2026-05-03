/** @jest-environment jsdom */

import {
  useRemoteControlStore,
  selectInboundConfig,
  selectOutboundConfig,
  selectStatus,
  selectRecentCalls,
} from "./store"
import {
  remoteControlGetStatus,
  remoteControlSetSigningSecret,
  remoteControlStart,
  remoteControlStop,
  remoteControlUpdateConfig,
} from "@/lib/tauri/remote-control"
import { isTauri } from "@/lib/tauri"
import {
  DEFAULT_REMOTE_CONTROL_CONFIG,
  DEFAULT_REMOTE_CONTROL_PORT,
  REMOTE_CONTROL_RECENT_CALLS_LIMIT,
} from "@/types/remote-control"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/tauri/remote-control", () => ({
  remoteControlGetStatus: jest.fn(),
  remoteControlSetSigningSecret: jest.fn(),
  remoteControlStart: jest.fn(),
  remoteControlStop: jest.fn(),
  remoteControlUpdateConfig: jest.fn(),
}))

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

beforeEach(() => {
  jest.clearAllMocks()
  // Reset persisted localStorage between cases.
  localStorage.clear()
  useRemoteControlStore.getState().reset()
})

describe("useRemoteControlStore — selectors", () => {
  it("returns the default config slices", () => {
    const state = useRemoteControlStore.getState()
    expect(selectInboundConfig(state)).toEqual(DEFAULT_REMOTE_CONTROL_CONFIG.inbound)
    expect(selectOutboundConfig(state)).toEqual(DEFAULT_REMOTE_CONTROL_CONFIG.outbound)
    expect(selectStatus(state).inboundRunning).toBe(false)
    expect(selectStatus(state).boundPort).toBeNull()
    expect(selectRecentCalls(state)).toEqual([])
  })
})

describe("useRemoteControlStore — web mode (no Tauri)", () => {
  beforeEach(() => {
    mockedIsTauri.mockReturnValue(false)
  })

  it("hydrate is a no-op", async () => {
    await useRemoteControlStore.getState().hydrate()
    expect(remoteControlGetStatus).not.toHaveBeenCalled()
  })

  it("updateInbound mutates the cache without calling Rust", async () => {
    const result = await useRemoteControlStore.getState().updateInbound({ port: 50000 })
    expect(result.ok).toBe(true)
    expect(remoteControlUpdateConfig).not.toHaveBeenCalled()
    expect(useRemoteControlStore.getState().config.inbound.port).toBe(50000)
  })

  it("updateOutbound replaces defaultHeaders array", async () => {
    await useRemoteControlStore.getState().updateOutbound({
      defaultHeaders: [{ name: "X-Foo", value: "bar" }],
    })
    expect(useRemoteControlStore.getState().config.outbound.defaultHeaders).toEqual([
      { name: "X-Foo", value: "bar" },
    ])
  })

  it("setOutboundHeaders is a thin wrapper", async () => {
    await useRemoteControlStore
      .getState()
      .setOutboundHeaders([{ name: "Authorization", value: "Bearer x" }])
    expect(useRemoteControlStore.getState().config.outbound.defaultHeaders).toHaveLength(1)
  })

  it("setSigningSecret mirrors hasSigningSecret without invoking Rust", async () => {
    await useRemoteControlStore.getState().setSigningSecret("hunter2")
    expect(useRemoteControlStore.getState().config.outbound.hasSigningSecret).toBe(true)
    await useRemoteControlStore.getState().setSigningSecret(null)
    expect(useRemoteControlStore.getState().config.outbound.hasSigningSecret).toBe(false)
    expect(remoteControlSetSigningSecret).not.toHaveBeenCalled()
  })

  it("startInbound and stopInbound surface the desktop-only error", async () => {
    const startResult = await useRemoteControlStore.getState().startInbound()
    expect(startResult.ok).toBe(false)
    expect(startResult.error).toMatch(/Tauri desktop runtime/)
    const stopResult = await useRemoteControlStore.getState().stopInbound()
    expect(stopResult.ok).toBe(false)
  })
})

describe("useRemoteControlStore — desktop mode", () => {
  beforeEach(() => {
    mockedIsTauri.mockReturnValue(true)
  })

  it("hydrate pulls live status from Rust", async () => {
    ;(remoteControlGetStatus as jest.Mock).mockResolvedValue({
      inboundRunning: true,
      boundPort: 47821,
      lastCallAt: "2026-05-03T10:00:00.000Z",
      inboundCallsTotal: 5,
      hasInboundToken: true,
    })
    await useRemoteControlStore.getState().hydrate()
    const status = useRemoteControlStore.getState().status
    expect(status.inboundRunning).toBe(true)
    expect(status.boundPort).toBe(DEFAULT_REMOTE_CONTROL_PORT)
    expect(status.inboundCallsTotal).toBe(5)
  })

  it("hydrate captures errors", async () => {
    ;(remoteControlGetStatus as jest.Mock).mockRejectedValue(new Error("offline"))
    await useRemoteControlStore.getState().hydrate()
    expect(useRemoteControlStore.getState().lastError).toBe("offline")
  })

  it("updateInbound pushes to Rust", async () => {
    ;(remoteControlUpdateConfig as jest.Mock).mockResolvedValue(undefined)
    const result = await useRemoteControlStore.getState().updateInbound({ rateLimitPerMin: 120 })
    expect(result.ok).toBe(true)
    expect(remoteControlUpdateConfig).toHaveBeenCalledTimes(1)
    const pushed = (remoteControlUpdateConfig as jest.Mock).mock.calls[0][0]
    expect(pushed.inbound.rateLimitPerMin).toBe(120)
  })

  it("updateInbound surfaces a Rust error", async () => {
    ;(remoteControlUpdateConfig as jest.Mock).mockRejectedValue(new Error("disk full"))
    const result = await useRemoteControlStore.getState().updateInbound({ port: 8080 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("disk full")
    expect(useRemoteControlStore.getState().lastError).toBe("disk full")
  })

  it("startInbound calls Rust and rehydrates", async () => {
    ;(remoteControlStart as jest.Mock).mockResolvedValue(undefined)
    ;(remoteControlGetStatus as jest.Mock).mockResolvedValue({
      inboundRunning: true,
      boundPort: 47821,
      lastCallAt: null,
      inboundCallsTotal: 0,
      hasInboundToken: true,
    })
    const result = await useRemoteControlStore.getState().startInbound()
    expect(result.ok).toBe(true)
    expect(remoteControlStart).toHaveBeenCalled()
    expect(useRemoteControlStore.getState().config.inbound.enabled).toBe(true)
  })

  it("stopInbound flips enabled false on success", async () => {
    ;(remoteControlStop as jest.Mock).mockResolvedValue(undefined)
    ;(remoteControlGetStatus as jest.Mock).mockResolvedValue({
      inboundRunning: false,
      boundPort: null,
      lastCallAt: null,
      inboundCallsTotal: 0,
      hasInboundToken: true,
    })
    const result = await useRemoteControlStore.getState().stopInbound()
    expect(result.ok).toBe(true)
    expect(useRemoteControlStore.getState().config.inbound.enabled).toBe(false)
  })

  it("setSigningSecret pushes to keyring", async () => {
    ;(remoteControlSetSigningSecret as jest.Mock).mockResolvedValue(undefined)
    const result = await useRemoteControlStore.getState().setSigningSecret("hunter2")
    expect(result.ok).toBe(true)
    expect(remoteControlSetSigningSecret).toHaveBeenCalledWith("hunter2")
    expect(useRemoteControlStore.getState().config.outbound.hasSigningSecret).toBe(true)
  })

  it("setSigningSecret clears with empty string and null alike", async () => {
    ;(remoteControlSetSigningSecret as jest.Mock).mockResolvedValue(undefined)
    await useRemoteControlStore.getState().setSigningSecret("")
    expect(remoteControlSetSigningSecret).toHaveBeenCalledWith(null)
    expect(useRemoteControlStore.getState().config.outbound.hasSigningSecret).toBe(false)
  })
})

describe("recordInboundCall ring buffer", () => {
  it("prepends entries and caps at REMOTE_CONTROL_RECENT_CALLS_LIMIT", () => {
    const { recordInboundCall, reset } = useRemoteControlStore.getState()
    reset()
    for (let i = 0; i < REMOTE_CONTROL_RECENT_CALLS_LIMIT + 5; i++) {
      recordInboundCall({
        id: `id-${i}`,
        at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        route: "/api/v1/health",
        status: 200,
        remoteIp: "127.0.0.1",
      })
    }
    const calls = useRemoteControlStore.getState().recentCalls
    expect(calls).toHaveLength(REMOTE_CONTROL_RECENT_CALLS_LIMIT)
    // newest first
    expect(calls[0].id).toBe(`id-${REMOTE_CONTROL_RECENT_CALLS_LIMIT + 4}`)
    expect(useRemoteControlStore.getState().status.inboundCallsTotal).toBe(
      REMOTE_CONTROL_RECENT_CALLS_LIMIT + 5
    )
    expect(useRemoteControlStore.getState().status.lastCallAt).toBe(calls[0].at)
  })
})
