const mockSetPluginEnabled = jest.fn(async () => undefined)
const mockEnablePlugin = jest.fn(async () => undefined)
const mockDisablePlugin = jest.fn(async () => undefined)

jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } },
}))
jest.mock("@/lib/db/plugins", () => ({
  setPluginEnabled: (...args: unknown[]) => mockSetPluginEnabled(...(args as [])),
}))
jest.mock("./manager", () => ({
  getPluginManager: () => ({
    enablePlugin: (...args: unknown[]) => mockEnablePlugin(...(args as [])),
    disablePlugin: (...args: unknown[]) => mockDisablePlugin(...(args as [])),
  }),
}))

import { togglePluginEnabled } from "./toggle-plugin-enabled"

beforeEach(() => {
  // `clearAllMocks` only clears call records — a `mockRejectedValue` or a
  // queued `mockImplementationOnce` from a previous test would survive it and
  // leak into the next one.
  mockSetPluginEnabled.mockReset().mockResolvedValue(undefined)
  mockEnablePlugin.mockReset().mockResolvedValue(undefined)
  mockDisablePlugin.mockReset().mockResolvedValue(undefined)
})

describe("enable", () => {
  it("writes the flag and runs a real activation", () => {
    // The gap this closes: the panel used to write only the Dexie flag, so
    // activate() never ran and the plugin read as enabled with no runtime.
    return togglePluginEnabled("p", true).then((result) => {
      expect(result).toEqual({ ok: true })
      expect(mockSetPluginEnabled).toHaveBeenCalledWith("p", true)
      expect(mockEnablePlugin).toHaveBeenCalledWith("p", "manual")
    })
  })

  it("writes the flag before awaiting the manager so the switch responds immediately", async () => {
    const order: string[] = []
    mockSetPluginEnabled.mockImplementation(async () => {
      order.push("flag")
    })
    mockEnablePlugin.mockImplementation(async () => {
      order.push("manager")
    })
    await togglePluginEnabled("p", true)
    expect(order).toEqual(["flag", "manager"])
  })

  it("forwards a custom reason", async () => {
    await togglePluginEnabled("p", true, "batch")
    expect(mockEnablePlugin).toHaveBeenCalledWith("p", "batch")
  })
})

describe("disable", () => {
  it("routes through the manager, not a bare flag write", async () => {
    await togglePluginEnabled("p", false)
    expect(mockSetPluginEnabled).toHaveBeenCalledWith("p", false)
    expect(mockDisablePlugin).toHaveBeenCalledWith("p", "manual")
    expect(mockEnablePlugin).not.toHaveBeenCalled()
  })
})

describe("failure", () => {
  it("reverts the optimistic flag when activation fails", async () => {
    mockEnablePlugin.mockRejectedValue(new Error("activate() timed out"))
    const result = await togglePluginEnabled("p", true)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("activate() timed out")
    // Snapped back, so the switch does not keep claiming a runtime that never
    // started.
    expect(mockSetPluginEnabled).toHaveBeenNthCalledWith(1, "p", true)
    expect(mockSetPluginEnabled).toHaveBeenNthCalledWith(2, "p", false)
  })

  it("reverts on a failed disable too", async () => {
    mockDisablePlugin.mockRejectedValue(new Error("teardown failed"))
    const result = await togglePluginEnabled("p", false)
    expect(result.ok).toBe(false)
    expect(mockSetPluginEnabled).toHaveBeenNthCalledWith(2, "p", true)
  })

  it("still reports the manager failure when the revert itself fails", async () => {
    // The revert is best-effort — masking the real error behind a Dexie write
    // failure would hide the thing the user needs to see.
    mockEnablePlugin.mockRejectedValue(new Error("real failure"))
    mockSetPluginEnabled
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("db gone")
      })

    const result = await togglePluginEnabled("p", true)
    expect(result).toEqual({ ok: false, error: "real failure" })
  })

  it("stringifies a non-Error rejection", async () => {
    mockEnablePlugin.mockRejectedValue("plain string")
    const result = await togglePluginEnabled("p", true)
    expect(result.error).toBe("plain string")
  })
})
