/**
 * @jest-environment node
 */
import {
  clearAllMessagePartRenderers,
  clearMessagePartRenderersForPlugin,
  getMessagePartRenderer,
  getMessagePartRenderersRevision,
  listMessagePartRenderers,
  registerMessagePartRenderer,
  subscribeMessagePartRenderers,
} from "./message-part-renderers"

const Stub = () => null

beforeEach(() => {
  clearAllMessagePartRenderers()
})

describe("registerMessagePartRenderer", () => {
  it("adds a new entry that getMessagePartRenderer can look up by type", () => {
    registerMessagePartRenderer("plugin-a", "weather", Stub)
    const entry = getMessagePartRenderer("weather")
    expect(entry).toBeDefined()
    expect(entry?.pluginId).toBe("plugin-a")
    expect(entry?.component).toBe(Stub)
  })

  it("returns an unregister callback that removes the entry", () => {
    const off = registerMessagePartRenderer("plugin-a", "weather", Stub)
    expect(getMessagePartRenderer("weather")).toBeDefined()
    off()
    expect(getMessagePartRenderer("weather")).toBeUndefined()
  })

  it("later registration wins; unregistering restores the prior owner", () => {
    const StubB = () => null
    const offA = registerMessagePartRenderer("plugin-a", "weather", Stub)
    const offB = registerMessagePartRenderer("plugin-b", "weather", StubB)
    expect(getMessagePartRenderer("weather")?.pluginId).toBe("plugin-b")
    offB()
    expect(getMessagePartRenderer("weather")?.pluginId).toBe("plugin-a")
    offA()
    expect(getMessagePartRenderer("weather")).toBeUndefined()
  })

  it("bumps the revision on every mutation and notifies subscribers", () => {
    const r0 = getMessagePartRenderersRevision()
    const listener = jest.fn()
    const offSub = subscribeMessagePartRenderers(listener)
    const off = registerMessagePartRenderer("plugin-a", "weather", Stub)
    expect(getMessagePartRenderersRevision()).toBeGreaterThan(r0)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    expect(listener).toHaveBeenCalledTimes(2)
    offSub()
  })

  it("listMessagePartRenderers returns entries sorted by type", () => {
    registerMessagePartRenderer("p1", "zebra", Stub)
    registerMessagePartRenderer("p1", "alpha", Stub)
    registerMessagePartRenderer("p1", "mango", Stub)
    expect(listMessagePartRenderers().map((e) => e.type)).toEqual(["alpha", "mango", "zebra"])
  })
})

describe("clearMessagePartRenderersForPlugin", () => {
  it("removes every entry owned by the plugin", () => {
    registerMessagePartRenderer("plugin-a", "a1", Stub)
    registerMessagePartRenderer("plugin-a", "a2", Stub)
    registerMessagePartRenderer("plugin-b", "b1", Stub)
    clearMessagePartRenderersForPlugin("plugin-a")
    expect(getMessagePartRenderer("a1")).toBeUndefined()
    expect(getMessagePartRenderer("a2")).toBeUndefined()
    expect(getMessagePartRenderer("b1")?.pluginId).toBe("plugin-b")
  })

  it("is a no-op when the plugin has no entries", () => {
    const r0 = getMessagePartRenderersRevision()
    clearMessagePartRenderersForPlugin("ghost")
    expect(getMessagePartRenderersRevision()).toBe(r0)
  })
})
