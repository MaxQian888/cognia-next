/**
 * Coverage for the MCP server Tauri command wrappers.
 *
 * Routes through `transport` from `@/lib/tauri` (M1.4) — tests spy on the
 * shared transport instead of mocking `invoke` directly.
 */

import {
  getMcpServerStatus,
  restartMcpServer,
  startMcpServer,
  stopMcpServer,
} from "./tauri-control"
import { transport } from "@/lib/tauri"
import type { ExternalBridgeSettings } from "@/types/wiki"

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
})
