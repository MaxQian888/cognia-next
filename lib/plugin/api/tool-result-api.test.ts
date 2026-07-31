/**
 * @jest-environment node
 */
import { createToolResultAPI, purgeToolResultRenderersForPlugin } from "./tool-result-api"
import {
  clearAllToolResultRenderers,
  getToolResultRenderer,
  listToolResultRenderers,
} from "./tool-result-renderers"

const Stub = () => null

const warn = jest.fn()
jest.mock("../core/logger", () => ({
  createPluginSystemLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}))

beforeEach(() => {
  clearAllToolResultRenderers()
  warn.mockClear()
})

describe("createToolResultAPI", () => {
  it("registers a card and exposes it on the registry", () => {
    const api = createToolResultAPI("plugin-a")
    const off = api.registerToolResultRenderer("my_tool", Stub)

    expect(getToolResultRenderer("my_tool")?.pluginId).toBe("plugin-a")

    off()
    expect(getToolResultRenderer("my_tool")).toBeUndefined()
  })

  it("normalizes the name so one registration covers every provider path", () => {
    const api = createToolResultAPI("plugin-a")
    api.registerToolResultRenderer("  mcp__cognia-plugin-tools__my_tool  ", Stub)

    expect(getToolResultRenderer("my_tool")?.component).toBe(Stub)
    expect(listToolResultRenderers()[0].toolName).toBe("my_tool")
  })

  it("refuses an empty tool name and returns a noop unregister", () => {
    const api = createToolResultAPI("plugin-a")
    const off = api.registerToolResultRenderer("   ", Stub)

    expect(listToolResultRenderers()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("empty tool name"))
    expect(() => off()).not.toThrow()
  })

  it("refuses a non-string tool name from untyped plugin code", () => {
    const api = createToolResultAPI("plugin-a")
    const off = api.registerToolResultRenderer(undefined as unknown as string, Stub)

    expect(listToolResultRenderers()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("empty tool name"))
    expect(() => off()).not.toThrow()
  })

  it("accepts a host-owned name but says it will be inert", () => {
    // The host's built-in card table is consulted first, so this registration
    // is harmless — it simply never wins. The API says so rather than keeping a
    // duplicate reserved-name list that would drift from the real one.
    const api = createToolResultAPI("plugin-a")
    api.registerToolResultRenderer("Read", Stub)
    expect(getToolResultRenderer("Read")?.pluginId).toBe("plugin-a")
  })
})

describe("purgeToolResultRenderersForPlugin", () => {
  it("drops every card the plugin owns", () => {
    const a = createToolResultAPI("plugin-a")
    const b = createToolResultAPI("plugin-b")
    a.registerToolResultRenderer("one", Stub)
    a.registerToolResultRenderer("two", Stub)
    b.registerToolResultRenderer("three", Stub)

    purgeToolResultRenderersForPlugin("plugin-a")

    expect(getToolResultRenderer("one")).toBeUndefined()
    expect(getToolResultRenderer("two")).toBeUndefined()
    expect(getToolResultRenderer("three")?.pluginId).toBe("plugin-b")
  })
})
