/**
 * @jest-environment jsdom
 */

import {
  PLUGIN_ERROR_EVENT,
  dispatchPluginError,
  subscribePluginError,
  type PluginErrorEventDetail,
} from "./error-bus"

jest.mock("@cognia/logging", () => ({
  loggers: {
    plugin: {
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
}))

import { loggers } from "@cognia/logging"

const warnMock = loggers.plugin.warn as unknown as jest.Mock
const errorMock = loggers.plugin.error as unknown as jest.Mock

beforeEach(() => {
  warnMock.mockClear()
  errorMock.mockClear()
})

const baseDetail = (): PluginErrorEventDetail => ({
  pluginId: "plg-1",
  pluginName: "Plugin One",
  stage: "install",
  message: "boom",
  severity: "error",
  recoverable: false,
})

describe("error-bus", () => {
  it("delivers events to subscribers with the full detail payload", () => {
    const seen: PluginErrorEventDetail[] = []
    const unsubscribe = subscribePluginError((d) => seen.push(d))
    dispatchPluginError(baseDetail())
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      pluginId: "plg-1",
      stage: "install",
      severity: "error",
      recoverable: false,
    })
    unsubscribe()
  })

  it("logs errors with the structured logger so headless callers still record them", () => {
    dispatchPluginError(baseDetail())
    expect(errorMock).toHaveBeenCalledTimes(1)
    expect(errorMock.mock.calls[0][0]).toContain("[install]")
    expect(errorMock.mock.calls[0][0]).toContain("plg-1")
    expect(errorMock.mock.calls[0][0]).toContain("(Plugin One)")
    expect(warnMock).not.toHaveBeenCalled()
  })

  it("routes severity=warning through logger.warn", () => {
    dispatchPluginError({ ...baseDetail(), severity: "warning" })
    expect(warnMock).toHaveBeenCalledTimes(1)
    expect(errorMock).not.toHaveBeenCalled()
  })

  it("filters malformed events (missing detail or pluginId)", () => {
    const seen: PluginErrorEventDetail[] = []
    const unsubscribe = subscribePluginError((d) => seen.push(d))
    window.dispatchEvent(new CustomEvent(PLUGIN_ERROR_EVENT, { detail: undefined }))
    window.dispatchEvent(
      new CustomEvent(PLUGIN_ERROR_EVENT, {
        detail: { ...baseDetail(), pluginId: "" },
      })
    )
    expect(seen).toHaveLength(0)
    unsubscribe()
  })

  it("unsubscribe stops further delivery without affecting other subscribers", () => {
    const a: PluginErrorEventDetail[] = []
    const b: PluginErrorEventDetail[] = []
    const unA = subscribePluginError((d) => a.push(d))
    const unB = subscribePluginError((d) => b.push(d))
    dispatchPluginError(baseDetail())
    unA()
    dispatchPluginError({ ...baseDetail(), pluginId: "plg-2" })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
    expect(b[1].pluginId).toBe("plg-2")
    unB()
  })

  it("dispatchPluginError never throws even with minimal payload", () => {
    expect(() =>
      dispatchPluginError({
        pluginId: "min",
        stage: "config",
        message: "",
        severity: "warning",
        recoverable: true,
      })
    ).not.toThrow()
  })
})
