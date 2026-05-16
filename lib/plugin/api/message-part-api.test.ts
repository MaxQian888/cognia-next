/**
 * @jest-environment node
 */
import { createMessagePartAPI, purgeMessagePartRenderersForPlugin } from "./message-part-api"
import { clearAllMessagePartRenderers, getMessagePartRenderer } from "./message-part-renderers"

const Stub = () => null

jest.mock("../core/logger", () => ({
  createPluginSystemLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}))

beforeEach(() => {
  clearAllMessagePartRenderers()
})

describe("createMessagePartAPI", () => {
  it("registers a renderer via the API and exposes it on the registry", () => {
    const api = createMessagePartAPI("plugin-a")
    const off = api.registerPartRenderer("weather", Stub)
    expect(getMessagePartRenderer("weather")?.pluginId).toBe("plugin-a")
    off()
    expect(getMessagePartRenderer("weather")).toBeUndefined()
  })

  it("rejects reserved type prefixes (`tool-`)", () => {
    const api = createMessagePartAPI("plugin-a")
    const off = api.registerPartRenderer("tool-Bash", Stub)
    expect(getMessagePartRenderer("tool-Bash")).toBeUndefined()
    off() // noop unregister — should not throw
  })

  it("rejects reserved exact types (artifact / sources / canvas / a2ui)", () => {
    const api = createMessagePartAPI("plugin-a")
    for (const type of [
      "artifact",
      "sources",
      "canvas",
      "a2ui",
      "subagent",
      "agent-team-dispatch",
    ]) {
      api.registerPartRenderer(type, Stub)
      expect(getMessagePartRenderer(type)).toBeUndefined()
    }
  })

  it("rejects host-owned simple types (text / reasoning / file)", () => {
    const api = createMessagePartAPI("plugin-a")
    api.registerPartRenderer("text", Stub)
    expect(getMessagePartRenderer("text")).toBeUndefined()
    api.registerPartRenderer("reasoning", Stub)
    expect(getMessagePartRenderer("reasoning")).toBeUndefined()
    api.registerPartRenderer("file", Stub)
    expect(getMessagePartRenderer("file")).toBeUndefined()
  })

  it("rejects empty string types", () => {
    const api = createMessagePartAPI("plugin-a")
    const off = api.registerPartRenderer("", Stub)
    expect(typeof off).toBe("function")
  })

  it("allows registration for an arbitrary plugin-owned type", () => {
    const api = createMessagePartAPI("plugin-a")
    api.registerPartRenderer("my-plugin:dashboard", Stub)
    expect(getMessagePartRenderer("my-plugin:dashboard")).toBeDefined()
  })
})

describe("purgeMessagePartRenderersForPlugin", () => {
  it("drops every renderer the plugin had registered", () => {
    const apiA = createMessagePartAPI("plugin-a")
    const apiB = createMessagePartAPI("plugin-b")
    apiA.registerPartRenderer("a-1", Stub)
    apiA.registerPartRenderer("a-2", Stub)
    apiB.registerPartRenderer("b-1", Stub)

    purgeMessagePartRenderersForPlugin("plugin-a")

    expect(getMessagePartRenderer("a-1")).toBeUndefined()
    expect(getMessagePartRenderer("a-2")).toBeUndefined()
    expect(getMessagePartRenderer("b-1")).toBeDefined()
  })
})
