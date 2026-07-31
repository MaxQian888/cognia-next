/** @jest-environment jsdom */
/**
 * Coverage for the MCP server Tauri command wrappers.
 *
 * Routes through `transport` from `@/lib/tauri` (M1.4) — tests spy on the
 * shared transport instead of mocking `invoke` directly.
 */

import {
  createExternalBridgeClient,
  getExternalBridgeConfig,
  getExternalBridgeStatus,
  getMcpServerStatus,
  isMcpServerHostAvailable,
  listExternalBridgeClients,
  restartExternalBridge,
  restartMcpServer,
  rotateExternalBridgeClient,
  startExternalBridge,
  startMcpServer,
  stopExternalBridge,
  stopMcpServer,
  updateExternalBridgeConfig,
} from "./tauri-control"
import { transport } from "@/lib/tauri"
import type { ExternalBridgeSettings } from "@/types/wiki"
import { setActiveRemoteTransport, __resetRoutingForTests } from "@/lib/tauri/transport-routing"

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  setTauri(false)
  __resetRoutingForTests()
  jest.restoreAllMocks()
})

const SAMPLE_SETTINGS: ExternalBridgeSettings = {
  enabled: true,
  enabledScopes: ["wiki:cognia", "rag:cognia"],
  bearerToken: "abc",
}

describe("startMcpServer", () => {
  it("calls mcp_server_start with serialized settings", async () => {
    callSpy.mockResolvedValueOnce(3001)
    const port = await startMcpServer({
      port: 0,
      token: "abc",
      settings: SAMPLE_SETTINGS,
      sidecarPath: "/path/to/cognia-mcp.js",
    })
    expect(port).toBe(3001)
    expect(callSpy).toHaveBeenCalledWith("mcp_server_start", {
      port: 0,
      token: "abc",
      settingsJson: JSON.stringify(SAMPLE_SETTINGS),
      sidecarPath: "/path/to/cognia-mcp.js",
    })
  })
})

describe("stopMcpServer", () => {
  it("calls mcp_server_stop without arguments", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await stopMcpServer()
    expect(callSpy).toHaveBeenCalledWith("mcp_server_stop")
  })
})

describe("restartMcpServer", () => {
  it("calls mcp_server_restart with serialized settings", async () => {
    callSpy.mockResolvedValueOnce(3002)
    const port = await restartMcpServer({
      port: 3001,
      token: "tok",
      settings: SAMPLE_SETTINGS,
      sidecarPath: "x",
    })
    expect(port).toBe(3002)
    expect(callSpy).toHaveBeenCalledWith("mcp_server_restart", {
      port: 3001,
      token: "tok",
      settingsJson: JSON.stringify(SAMPLE_SETTINGS),
      sidecarPath: "x",
    })
  })
})

describe("getMcpServerStatus", () => {
  it("returns a stub status in plain-web mode (no transport call fired)", async () => {
    setTauri(false)
    const status = await getMcpServerStatus()
    expect(status).toEqual({ running: false, port: null, startedAt: null })
    expect(callSpy).not.toHaveBeenCalled()
  })

  it("forwards the Rust-side status verbatim in Tauri mode", async () => {
    callSpy.mockResolvedValueOnce({
      running: true,
      port: 3001,
      startedAt: "2026-05-04T12:34:56Z",
    })
    const status = await getMcpServerStatus()
    expect(status.running).toBe(true)
    expect(status.port).toBe(3001)
    expect(status.startedAt).toBe("2026-05-04T12:34:56Z")
  })

  it("does not fall back to legacy MCP lifecycle through an active remote host", async () => {
    setTauri(false)
    setActiveRemoteTransport({
      call: jest.fn(),
      subscribe: jest.fn(() => () => {}),
    })
    expect(isMcpServerHostAvailable()).toBe(false)

    await expect(getMcpServerStatus()).resolves.toEqual({
      running: false,
      port: null,
      startedAt: null,
    })
    expect(callSpy).not.toHaveBeenCalled()
  })
})

describe("host-managed External Bridge", () => {
  it("uses revisioned host configuration and scoped client RPCs", async () => {
    callSpy
      .mockResolvedValueOnce({
        revision: 1,
        enabledScopes: ["wiki:cognia"],
        port: 47890,
        bindMode: "loopback",
        autoStart: false,
      })
      .mockResolvedValueOnce({ revision: 2 })
      .mockResolvedValueOnce({ client: { id: "client-1" }, credential: "once" })
      .mockResolvedValueOnce([{ id: "client-1" }])
      .mockResolvedValueOnce({ client: { id: "client-1" }, credential: "rotated" })

    await getExternalBridgeConfig()
    await updateExternalBridgeConfig(
      {
        expectedRevision: 1,
        enabledScopes: ["wiki:cognia"],
        port: 47890,
        bindMode: "loopback",
        autoStart: false,
      },
      "lease-1"
    )
    await createExternalBridgeClient({ name: "Cursor", scopes: ["wiki:cognia"] }, "lease-1")
    await listExternalBridgeClients()
    await rotateExternalBridgeClient("client-1", "lease-1")

    expect(callSpy.mock.calls).toEqual([
      ["external_bridge_config_get"],
      [
        "external_bridge_config_update",
        {
          update: {
            expectedRevision: 1,
            enabledScopes: ["wiki:cognia"],
            port: 47890,
            bindMode: "loopback",
            autoStart: false,
          },
          adminLease: "lease-1",
        },
      ],
      [
        "external_bridge_client_create",
        { name: "Cursor", scopes: ["wiki:cognia"], adminLease: "lease-1" },
      ],
      ["external_bridge_client_list"],
      ["external_bridge_client_rotate", { clientId: "client-1", adminLease: "lease-1" }],
    ])
  })

  it("routes lifecycle and redacted status through the host APIs", async () => {
    callSpy
      .mockResolvedValueOnce(47890)
      .mockResolvedValueOnce(47891)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ state: "stopped", configRevision: 2 })

    await startExternalBridge("lease-1")
    await restartExternalBridge("lease-1")
    await stopExternalBridge("lease-1")
    await getExternalBridgeStatus()

    expect(callSpy.mock.calls).toEqual([
      ["external_bridge_start", { adminLease: "lease-1" }],
      ["external_bridge_restart", { adminLease: "lease-1" }],
      ["external_bridge_stop", { adminLease: "lease-1" }],
      ["external_bridge_status"],
    ])
  })
})
