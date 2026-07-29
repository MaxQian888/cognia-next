/**
 * @jest-environment node
 */

let tauriHost = true
const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauriHost,
  transport: {
    call: (...args: unknown[]) => callMock(...args),
  },
}))

import { DEFAULT_BRIDGE_HTTP_PORT, resolveSidecarPath } from "./bridge-runtime"

beforeEach(() => {
  jest.clearAllMocks()
  tauriHost = true
})

describe("DEFAULT_BRIDGE_HTTP_PORT", () => {
  it("is a concrete port, not 0", () => {
    // An OS-assigned port cannot be written into a client config ahead of
    // time, and producing such a config is this surface's whole job. The two
    // former call sites disagreed here (`?? 0` vs `?? 3001`).
    expect(DEFAULT_BRIDGE_HTTP_PORT).toBe(3001)
  })
})

describe("resolveSidecarPath", () => {
  it("returns whatever Rust resolved against the real filesystem", async () => {
    callMock.mockResolvedValue("/Applications/Cognia.app/.../sidecar/cognia-mcp.mjs")

    await expect(resolveSidecarPath()).resolves.toBe(
      "/Applications/Cognia.app/.../sidecar/cognia-mcp.mjs"
    )
    expect(callMock).toHaveBeenCalledWith("mcp_server_sidecar_path")
  })

  it("reports null when the sidecar is not installed", async () => {
    // The defect this replaced: a synthesised `~/.cognia/cognia-mcp.js` that
    // no build step ever wrote was returned as though it were real, and both
    // spawned against and printed into the setup snippet.
    callMock.mockResolvedValue(null)

    await expect(resolveSidecarPath()).resolves.toBeNull()
  })

  it("never synthesises a path in web mode, where there is no sidecar at all", async () => {
    tauriHost = false

    await expect(resolveSidecarPath()).resolves.toBeNull()
    expect(callMock).not.toHaveBeenCalled()
  })

  it("degrades to null rather than throwing when the command is unavailable", async () => {
    callMock.mockRejectedValue(new Error("Command not found"))

    await expect(resolveSidecarPath()).resolves.toBeNull()
  })
})
