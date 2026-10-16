export {}

const localCall = jest.fn()
const routedCall = jest.fn()
let tauri = false
let headless = false

jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))
jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: () => headless }))
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: (...args: unknown[]) => localCall(...args) },
  transport: { call: (...args: unknown[]) => routedCall(...args) },
}))

import {
  browserSocketStatus,
  callBrowserSocket,
  hostServesBrowserSockets,
  notifyBrowserSocket,
} from "./host-transport"

describe("the Host's way to its paired browsers' sockets", () => {
  beforeEach(() => {
    localCall.mockReset()
    routedCall.mockReset()
    tauri = false
    headless = false
  })

  it("is served by the desktop and by the headless brain, nowhere else", () => {
    expect(hostServesBrowserSockets()).toBe(false)
    tauri = true
    expect(hostServesBrowserSockets()).toBe(true)
    tauri = false
    headless = true
    expect(hostServesBrowserSockets()).toBe(true)
  })

  it("asks the desktop's own server even while the window drives a remote Host", async () => {
    tauri = true
    localCall.mockResolvedValue({ connected: true, driveAllowed: false })
    await expect(browserSocketStatus("browser-1")).resolves.toEqual({
      connected: true,
      driveAllowed: false,
    })
    expect(localCall).toHaveBeenCalledWith("companion_browser_extension_status", {
      deviceId: "browser-1",
    })
    expect(routedCall).not.toHaveBeenCalled()
  })

  it("asks the brain's own server through the transport the serve boot installed", async () => {
    headless = true
    routedCall.mockResolvedValue(null)
    await notifyBrowserSocket("browser-2")
    expect(routedCall).toHaveBeenCalledWith("companion_browser_extension_notify", {
      deviceId: "browser-2",
    })
    expect(localCall).not.toHaveBeenCalled()
  })

  it("sends an operation with exactly the arguments the service plane declares", async () => {
    headless = true
    routedCall.mockResolvedValue({ ok: true })
    await expect(
      callBrowserSocket({
        deviceId: "browser-3",
        operation: "snapshot",
        args: { session: "chat-1" },
        timeoutMs: 5_000,
      })
    ).resolves.toEqual({ ok: true })
    expect(routedCall).toHaveBeenCalledWith("companion_browser_extension_call", {
      deviceId: "browser-3",
      operation: "snapshot",
      args: { session: "chat-1" },
      timeoutMs: 5_000,
    })
  })

  it("keeps the socket's refusal code for the engine to map", async () => {
    headless = true
    const refusal = Object.assign(new Error("not allowed"), { code: "browser_drive_forbidden" })
    routedCall.mockRejectedValue(refusal)
    await expect(
      callBrowserSocket({ deviceId: "b", operation: "act", args: {}, timeoutMs: 1_000 })
    ).rejects.toMatchObject({ code: "browser_drive_forbidden" })
  })
})
