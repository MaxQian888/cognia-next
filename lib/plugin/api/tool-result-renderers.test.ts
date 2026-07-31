import type React from "react"

import {
  clearAllToolResultRenderers,
  clearToolResultRenderersForPlugin,
  getToolResultRenderer,
  getToolResultRenderersRevision,
  listToolResultRenderers,
  registerToolResultRenderer,
  subscribeToolResultRenderers,
  toolResultRendererKey,
  type ToolResultRendererProps,
} from "./tool-result-renderers"

const CardA = (() => null) as React.ComponentType<ToolResultRendererProps>
const CardB = (() => null) as React.ComponentType<ToolResultRendererProps>

afterEach(() => clearAllToolResultRenderers())

describe("toolResultRendererKey", () => {
  it("folds the part-type prefix and any mcp namespace onto the bare tool name", () => {
    expect(toolResultRendererKey("my_tool")).toBe("my_tool")
    expect(toolResultRendererKey("tool-my_tool")).toBe("my_tool")
    expect(toolResultRendererKey("mcp__cognia-plugin-tools__my_tool")).toBe("my_tool")
    expect(toolResultRendererKey("tool-mcp__cognia-plugin-tools__my_tool")).toBe("my_tool")
  })
})

describe("registerToolResultRenderer", () => {
  it("resolves a lookup by bare, prefixed, and namespaced name alike", () => {
    registerToolResultRenderer("p1", "my_tool", CardA)

    expect(getToolResultRenderer("my_tool")?.component).toBe(CardA)
    expect(getToolResultRenderer("tool-my_tool")?.component).toBe(CardA)
    expect(getToolResultRenderer("mcp__cognia-plugin-tools__my_tool")?.component).toBe(CardA)
  })

  it("normalizes the stored tool name so listings are canonical", () => {
    registerToolResultRenderer("p1", "mcp__cognia-plugin-tools__my_tool", CardA)
    expect(listToolResultRenderers()).toEqual([
      { pluginId: "p1", toolName: "my_tool", component: CardA },
    ])
  })

  it("returns undefined for an unregistered tool", () => {
    expect(getToolResultRenderer("nobody")).toBeUndefined()
  })

  it("lets the latest registration win and restores the prior owner on unregister", () => {
    registerToolResultRenderer("p1", "shared", CardA)
    const undoB = registerToolResultRenderer("p2", "shared", CardB)

    expect(getToolResultRenderer("shared")?.pluginId).toBe("p2")

    undoB()

    // p1's card comes back rather than the tool silently losing its renderer.
    expect(getToolResultRenderer("shared")?.pluginId).toBe("p1")
    expect(getToolResultRenderer("shared")?.component).toBe(CardA)
  })

  it("deletes outright when the same plugin re-registers and then unregisters", () => {
    registerToolResultRenderer("p1", "solo", CardA)
    const undo = registerToolResultRenderer("p1", "solo", CardB)
    undo()
    expect(getToolResultRenderer("solo")).toBeUndefined()
  })

  it("ignores a stale unregister after someone else took the slot", () => {
    const undoA = registerToolResultRenderer("p1", "shared", CardA)
    registerToolResultRenderer("p2", "shared", CardB)
    undoA()
    expect(getToolResultRenderer("shared")?.pluginId).toBe("p2")
  })

  it("sorts listings by tool name", () => {
    registerToolResultRenderer("p1", "zeta", CardA)
    registerToolResultRenderer("p1", "alpha", CardB)
    expect(listToolResultRenderers().map((e) => e.toolName)).toEqual(["alpha", "zeta"])
  })
})

describe("clearToolResultRenderersForPlugin", () => {
  it("drops only the named plugin's entries", () => {
    registerToolResultRenderer("p1", "a", CardA)
    registerToolResultRenderer("p2", "b", CardB)

    clearToolResultRenderersForPlugin("p1")

    expect(getToolResultRenderer("a")).toBeUndefined()
    expect(getToolResultRenderer("b")?.pluginId).toBe("p2")
  })

  it("does not bump the revision when the plugin owned nothing", () => {
    const before = getToolResultRenderersRevision()
    clearToolResultRenderersForPlugin("ghost")
    expect(getToolResultRenderersRevision()).toBe(before)
  })
})

describe("subscription", () => {
  it("notifies listeners and bumps the revision on every mutation", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeToolResultRenderers(listener)
    const before = getToolResultRenderersRevision()

    const undo = registerToolResultRenderer("p1", "watched", CardA)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getToolResultRenderersRevision()).toBe(before + 1)

    undo()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    registerToolResultRenderer("p1", "unwatched", CardB)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("clearAll is a no-op on an already-empty registry", () => {
    const before = getToolResultRenderersRevision()
    clearAllToolResultRenderers()
    expect(getToolResultRenderersRevision()).toBe(before)
  })
})
