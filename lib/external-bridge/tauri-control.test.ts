/**
 * Coverage for the Tauri command wrappers.
 *
 * The test environment mocks `@tauri-apps/api/core` to capture invoke calls
 * without spawning a real Tauri process; `isTauri()` is also mockable for
 * the web-mode branches.
 */

import {
  getMcpServerStatus,
  restartMcpServer,
  startMcpServer,
  stopMcpServer,
} from "./tauri-control"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import type { ExternalBridgeSettings } from "@/types/wiki"

jest.mock("@tauri-apps/api/core")
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedIsTauri.mockReset()
  mockedIsTauri.mockReturnValue(true)
})

const SAMPLE_SETTINGS: ExternalBridgeSettings = {
  enabled: true,
  enabledScopes: ["wiki:cognia", "rag:cognia"],
  bearerToken: "abc",
}

describe("startMcpServer", () => {
  it("invokes mcp_server_start with serialized settings", async () => {
    mockedInvoke.mockResolvedValueOnce(3001 as never)
    const port = await startMcpServer({
      port: 0,
      token: "abc",
      settings: SAMPLE_SETTINGS,
      sidecarPath: "/path/to/cognia-mcp.js",
    })
    expect(port).toBe(3001)
    expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_start", {
      port: 0,
      token: "abc",
      settingsJson: JSON.stringify(SAMPLE_SETTINGS),
      sidecarPath: "/path/to/cognia-mcp.js",
    })
  })

  it("throws a friendly error in web mode", async () => {
    mockedIsTauri.mockReturnValue(false)
    await expect(
      startMcpServer({
        port: 0,
        token: "abc",
        settings: SAMPLE_SETTINGS,
        sidecarPath: "x",
      })
    ).rejects.toThrow(/Tauri-only/)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})

describe("stopMcpServer", () => {
  it("invokes mcp_server_stop without arguments", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined as never)
    await stopMcpServer()
    expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_stop")
  })

  it("throws in web mode", async () => {
    mockedIsTauri.mockReturnValue(false)
    await expect(stopMcpServer()).rejects.toThrow(/Tauri-only/)
  })
})

describe("restartMcpServer", () => {
  it("invokes mcp_server_restart with serialized settings", async () => {
    mockedInvoke.mockResolvedValueOnce(3002 as never)
    const port = await restartMcpServer({
      port: 3001,
      token: "tok",
      settings: SAMPLE_SETTINGS,
      sidecarPath: "x",
    })
    expect(port).toBe(3002)
    expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_restart", {
      port: 3001,
      token: "tok",
      settingsJson: JSON.stringify(SAMPLE_SETTINGS),
      sidecarPath: "x",
    })
  })
})

describe("getMcpServerStatus", () => {
  it("returns a stub status in web mode (no invoke fired)", async () => {
    mockedIsTauri.mockReturnValue(false)
    const status = await getMcpServerStatus()
    expect(status).toEqual({ running: false, port: null, startedAt: null })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("forwards the Rust-side status verbatim in Tauri mode", async () => {
    mockedInvoke.mockResolvedValueOnce({
      running: true,
      port: 3001,
      startedAt: "2026-05-04T12:34:56Z",
    } as never)
    const status = await getMcpServerStatus()
    expect(status.running).toBe(true)
    expect(status.port).toBe(3001)
    expect(status.startedAt).toBe("2026-05-04T12:34:56Z")
  })
})
