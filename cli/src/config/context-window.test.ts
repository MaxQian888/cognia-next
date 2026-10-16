/**
 * @jest-environment node
 */
import { configuredContextWindow, declaredModelWindows } from "./context-window"

const config = {
  providers: {
    relay: {
      model: "flash",
      contextWindow: 1_000_000,
      models: { small: { contextWindow: 32_000 }, plain: {} },
    },
    bare: { model: "x" },
  },
}

describe("configuredContextWindow", () => {
  it("prefers the per-model window, then the provider-wide one", () => {
    expect(configuredContextWindow(config, "relay", "small")).toBe(32_000)
    expect(configuredContextWindow(config, "relay", "plain")).toBe(1_000_000)
    expect(configuredContextWindow(config, "relay", "unlisted")).toBe(1_000_000)
    expect(configuredContextWindow(config, "relay", undefined)).toBe(1_000_000)
  })

  it("is undefined when nothing is declared", () => {
    expect(configuredContextWindow(config, "bare", "x")).toBeUndefined()
    expect(configuredContextWindow(config, "missing", "x")).toBeUndefined()
    expect(configuredContextWindow(config, undefined, "x")).toBeUndefined()
  })
})

describe("declaredModelWindows", () => {
  it("lists listed models, the default model and the active model", () => {
    expect(declaredModelWindows(config, "relay", "live")).toEqual([
      { id: "small", contextLength: 32_000 },
      { id: "plain", contextLength: 1_000_000 },
      { id: "flash", contextLength: 1_000_000 },
      { id: "live", contextLength: 1_000_000 },
    ])
  })

  it("returns no rows for a provider with no declared window", () => {
    expect(declaredModelWindows(config, "bare", "x")).toEqual([])
    expect(declaredModelWindows(config, "missing")).toEqual([])
  })
})
