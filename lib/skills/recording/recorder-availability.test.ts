import {
  __resetRecorderAvailabilityForTesting,
  clearRecorderAvailability,
  getRecorderAvailability,
  setRecorderAvailability,
  subscribeRecorderAvailability,
} from "./recorder-availability"

beforeEach(() => {
  __resetRecorderAvailabilityForTesting()
})

describe("recorder availability registry", () => {
  it("starts unavailable — nothing may record until the plugin says so", () => {
    expect(getRecorderAvailability()).toEqual({ available: false, pluginId: null })
  })

  it("publishes what `activate` supplies", () => {
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    expect(getRecorderAvailability()).toEqual({
      available: true,
      pluginId: "cognia-skill-recorder",
    })
  })

  it("goes back to unavailable on clear", () => {
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    clearRecorderAvailability()
    expect(getRecorderAvailability()).toEqual({ available: false, pluginId: null })
  })

  it("notifies subscribers on a real change", () => {
    const listener = jest.fn()
    subscribeRecorderAvailability(listener)
    setRecorderAvailability({ available: true, pluginId: "p" })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("does not notify when nothing changed", () => {
    // `useSyncExternalStore` re-reads on every notification; a no-op publish
    // from a plugin re-activation would re-render every entry point for nothing.
    setRecorderAvailability({ available: true, pluginId: "p" })
    const listener = jest.fn()
    subscribeRecorderAvailability(listener)
    setRecorderAvailability({ available: true, pluginId: "p" })
    expect(listener).not.toHaveBeenCalled()
  })

  it("returns a referentially stable snapshot between changes", () => {
    // An object rebuilt per read makes `useSyncExternalStore` loop forever.
    setRecorderAvailability({ available: true, pluginId: "p" })
    expect(getRecorderAvailability()).toBe(getRecorderAvailability())
  })

  it("stops notifying after unsubscribe", () => {
    const listener = jest.fn()
    subscribeRecorderAvailability(listener)()
    setRecorderAvailability({ available: true, pluginId: "p" })
    expect(listener).not.toHaveBeenCalled()
  })

  it("notifies every subscriber", () => {
    const a = jest.fn()
    const b = jest.fn()
    subscribeRecorderAvailability(a)
    subscribeRecorderAvailability(b)
    setRecorderAvailability({ available: true, pluginId: "p" })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("treats a plugin-id change as a change", () => {
    const listener = jest.fn()
    setRecorderAvailability({ available: true, pluginId: "a" })
    subscribeRecorderAvailability(listener)
    setRecorderAvailability({ available: true, pluginId: "b" })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getRecorderAvailability().pluginId).toBe("b")
  })
})
