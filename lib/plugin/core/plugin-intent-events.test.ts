jest.mock("@cognia/logging", () => ({ loggers: { plugin: { warn: jest.fn() } } }))

import { loggers } from "@cognia/logging"

import {
  __resetPluginIntentListenersForTesting,
  emitPluginIntentChange,
  subscribePluginIntentChanges,
} from "./plugin-intent-events"

describe("plugin intent events", () => {
  beforeEach(() => {
    __resetPluginIntentListenersForTesting()
    jest.clearAllMocks()
  })

  it("delivers changes until unsubscribed", () => {
    const seen: string[] = []
    const off = subscribePluginIntentChanges((change) =>
      seen.push(`${change.pluginId}:${change.intent}:${change.reason}`)
    )
    emitPluginIntentChange({ pluginId: "a", intent: "enabled", reason: "manual" })
    off()
    emitPluginIntentChange({ pluginId: "b", intent: "disabled", reason: "manual" })
    expect(seen).toEqual(["a:enabled:manual"])
  })

  it("isolates a throwing listener from the others", () => {
    const later = jest.fn()
    subscribePluginIntentChanges(() => {
      throw new Error("boom")
    })
    subscribePluginIntentChanges(later)
    emitPluginIntentChange({ pluginId: "a", intent: "enabled", reason: "cogset" })
    expect(later).toHaveBeenCalled()
    expect(loggers.plugin.warn).toHaveBeenCalledWith("[plugin:a] intent listener threw (ignored)", {
      error: "boom",
    })
  })
})
