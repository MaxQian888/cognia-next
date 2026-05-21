/**
 * @jest-environment jsdom
 */

import { requireBiometric } from "./prompt"

const mockIsTauri = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

const mockAsk = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => mockAsk(...args),
}))

beforeEach(() => {
  mockIsTauri.mockReset()
  mockAsk.mockReset()
})

describe("requireBiometric", () => {
  it("uses Tauri dialog when isTauri() is true and returns the chosen value", async () => {
    mockIsTauri.mockReturnValue(true)
    mockAsk.mockResolvedValueOnce(true)
    const result = await requireBiometric({ title: "x", message: "y" })
    expect(result).toEqual({ ok: true, bioVerified: false, via: "tauri-dialog" })
    expect(mockAsk).toHaveBeenCalledWith(
      "y",
      expect.objectContaining({ title: "x", kind: "warning" })
    )
  })

  it("returns ok=false when the user cancels in Tauri dialog", async () => {
    mockIsTauri.mockReturnValue(true)
    mockAsk.mockResolvedValueOnce(false)
    const result = await requireBiometric({ title: "x", message: "y" })
    expect(result.ok).toBe(false)
  })

  it("falls back to via=unavailable when Tauri dialog throws", async () => {
    mockIsTauri.mockReturnValue(true)
    mockAsk.mockRejectedValueOnce(new Error("no dialog"))
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const result = await requireBiometric({ title: "x", message: "y" })
    expect(result).toEqual({ ok: false, bioVerified: false, via: "unavailable" })
    consoleSpy.mockRestore()
  })

  it("falls back to window.confirm on web (not Tauri)", async () => {
    mockIsTauri.mockReturnValue(false)
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValueOnce(true)
    const result = await requireBiometric({ title: "Heads up", message: "Really?" })
    expect(result).toEqual({ ok: true, bioVerified: false, via: "browser-confirm" })
    expect(confirmSpy).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it("returns ok=false when the user dismisses the browser confirm", async () => {
    mockIsTauri.mockReturnValue(false)
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValueOnce(false)
    const result = await requireBiometric({ title: "x", message: "y" })
    expect(result.ok).toBe(false)
    confirmSpy.mockRestore()
  })
})
