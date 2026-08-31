const incrementAnalyticMock = jest.fn()
const debugMock = jest.fn()

jest.mock("@/lib/db/plugin-analytics", () => ({
  incrementAnalytic: (...args: unknown[]) => incrementAnalyticMock(...args),
}))
jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { debug: (...args: unknown[]) => debugMock(...args) } },
}))

import { PLUGIN_ANALYTIC_KEYS, recordPluginAnalytic } from "./record"

beforeEach(() => {
  incrementAnalyticMock.mockReset().mockResolvedValue(undefined)
  debugMock.mockReset()
})

describe("recordPluginAnalytic", () => {
  it("names a stable key per event", () => {
    expect(PLUGIN_ANALYTIC_KEYS).toEqual({
      enabled: "lifecycle.enabled",
      disabled: "lifecycle.disabled",
      surfaceError: "surface.error",
    })
  })

  it("bumps the counter for the plugin", async () => {
    await recordPluginAnalytic("acme.widgets", PLUGIN_ANALYTIC_KEYS.enabled)
    expect(incrementAnalyticMock).toHaveBeenCalledWith("acme.widgets", "lifecycle.enabled")
  })

  // Analytics must never fail a user action, and it is called with `void` from
  // paths that have no error handling of their own.
  it("swallows a write failure and logs it", async () => {
    incrementAnalyticMock.mockRejectedValue(new Error("db closed"))
    await expect(
      recordPluginAnalytic("acme.widgets", PLUGIN_ANALYTIC_KEYS.surfaceError)
    ).resolves.toBeUndefined()
    expect(debugMock).toHaveBeenCalled()
  })
})
