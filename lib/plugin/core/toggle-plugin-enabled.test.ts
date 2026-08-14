const mockSetPluginIntent = jest.fn(async () => undefined)

jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } },
}))
jest.mock("./manager", () => ({
  getPluginManager: () => ({
    setPluginIntent: (...args: unknown[]) => mockSetPluginIntent(...(args as [])),
  }),
}))

import { togglePluginEnabled } from "./toggle-plugin-enabled"

beforeEach(() => {
  // `clearAllMocks` only clears call records — a `mockRejectedValue` or a
  // queued `mockImplementationOnce` from a previous test would survive it and
  // leak into the next one.
  mockSetPluginIntent.mockReset().mockResolvedValue(undefined)
})

describe("enable", () => {
  it("routes enable through the manager's canonical desired-state transition", () => {
    // The gap this closes: the panel used to write only the Dexie flag, so
    // activate() never ran and the plugin read as enabled with no runtime.
    return togglePluginEnabled("p", true).then((result) => {
      expect(result).toEqual({ ok: true })
      expect(mockSetPluginIntent).toHaveBeenCalledWith("p", "enabled", "manual")
    })
  })

  it("forwards a custom reason", async () => {
    await togglePluginEnabled("p", true, "batch")
    expect(mockSetPluginIntent).toHaveBeenCalledWith("p", "enabled", "batch")
  })
})

describe("disable", () => {
  it("routes through the manager, not a bare flag write", async () => {
    await togglePluginEnabled("p", false)
    expect(mockSetPluginIntent).toHaveBeenCalledWith("p", "disabled", "manual")
  })
})

describe("failure", () => {
  it("reports activation failure while preserving the requested intent", async () => {
    mockSetPluginIntent.mockRejectedValue(new Error("activate() timed out"))
    const result = await togglePluginEnabled("p", true)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("activate() timed out")
    expect(mockSetPluginIntent).toHaveBeenCalledTimes(1)
  })

  it("reverts on a failed disable too", async () => {
    mockSetPluginIntent.mockRejectedValue(new Error("teardown failed"))
    const result = await togglePluginEnabled("p", false)
    expect(result.ok).toBe(false)
    expect(mockSetPluginIntent).toHaveBeenCalledTimes(1)
  })

  it("stringifies a non-Error rejection", async () => {
    mockSetPluginIntent.mockRejectedValue("plain string")
    const result = await togglePluginEnabled("p", true)
    expect(result.error).toBe("plain string")
  })
})
