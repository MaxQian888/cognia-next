/**
 * @jest-environment jsdom
 */

const mockInvoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

let mockIsTauri = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))

import { setWindowBackgroundColor } from "./shell-window"

beforeEach(() => {
  mockInvoke.mockReset()
  mockIsTauri = true
})

describe("setWindowBackgroundColor", () => {
  it("invokes the Tauri command with the hex string when running under Tauri", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const ok = await setWindowBackgroundColor("#ff8800")
    expect(ok).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("set_window_background_color", { hex: "#ff8800" })
  })

  it("returns false without calling invoke when not running under Tauri", async () => {
    mockIsTauri = false
    const ok = await setWindowBackgroundColor("#ff8800")
    expect(ok).toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("rejects invalid hex inputs before crossing the IPC boundary", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const ok = await setWindowBackgroundColor("not-a-color")
    expect(ok).toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it("accepts an 8-digit hex with alpha", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const ok = await setWindowBackgroundColor("#11223344")
    expect(ok).toBe(true)
    expect(mockInvoke).toHaveBeenCalled()
  })

  it("returns false (no throw) when the Tauri command rejects", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockRejectedValue(new Error("boom"))
    const ok = await setWindowBackgroundColor("#000000")
    expect(ok).toBe(false)
    consoleSpy.mockRestore()
  })
})
