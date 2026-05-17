/**
 * Coverage for `lib/cli-bridge/status.ts`. Three behaviours matter:
 *   - Outside Tauri the wrapper short-circuits without touching invoke().
 *   - Successful IPC round-trips return the camelCase payload verbatim.
 *   - IPC failures degrade to the not-available snapshot (no throw).
 */

import { getCliBridgeStatus } from "./status"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isTauri } = require("@/lib/tauri") as { isTauri: jest.Mock }

afterEach(() => {
  invoke.mockReset()
  isTauri.mockReset().mockReturnValue(true)
})

describe("getCliBridgeStatus", () => {
  it("returns the not-available snapshot when not running under Tauri", async () => {
    isTauri.mockReturnValue(false)
    const status = await getCliBridgeStatus()
    expect(status).toEqual({ running: false, boundPort: null, endpointFile: null })
    expect(invoke).not.toHaveBeenCalled()
  })

  it("passes through the running snapshot from Rust", async () => {
    invoke.mockResolvedValueOnce({
      running: true,
      boundPort: 42523,
      endpointFile: "C:/Users/dev/AppData/Roaming/cognia/cli-endpoint.json",
    })
    const status = await getCliBridgeStatus()
    expect(invoke).toHaveBeenCalledWith("cli_bridge_status")
    expect(status.running).toBe(true)
    expect(status.boundPort).toBe(42523)
    expect(status.endpointFile).toContain("cli-endpoint.json")
  })

  it("normalises missing or wrong-typed fields to safe defaults", async () => {
    // Rust may report `bound_port: None` (serialised as `null`) when the
    // bridge was started but later stopped — the wrapper should coerce that
    // to a typed `null` rather than `undefined`.
    invoke.mockResolvedValueOnce({
      running: false,
      boundPort: null,
      endpointFile: null,
    })
    const status = await getCliBridgeStatus()
    expect(status).toEqual({ running: false, boundPort: null, endpointFile: null })

    // Defense-in-depth: a malformed response (missing fields) must not crash.
    invoke.mockResolvedValueOnce({} as unknown)
    const fallback = await getCliBridgeStatus()
    expect(fallback).toEqual({ running: false, boundPort: null, endpointFile: null })
  })

  it("downgrades IPC failures to the not-available snapshot", async () => {
    invoke.mockRejectedValueOnce(new Error("bridge not managed"))
    const status = await getCliBridgeStatus()
    expect(status).toEqual({ running: false, boundPort: null, endpointFile: null })
  })
})
