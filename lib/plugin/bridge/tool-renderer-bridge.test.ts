import React from "react"

import {
  registerToolRenderersForPlugin,
  unregisterToolRenderersForPlugin,
} from "./tool-renderer-bridge"
import {
  clearAllToolResultRenderers,
  getToolResultRenderer,
  listToolResultRenderers,
} from "@/lib/plugin/api/tool-result-renderers"
import type { PluginManifest } from "@/types/plugin/plugin"

const manifest = (overrides: Partial<PluginManifest>): PluginManifest =>
  ({
    id: "p",
    name: "P",
    version: "1.0.0",
    description: "",
    type: "frontend",
    capabilities: ["tools"],
    main: "index.js",
    ...overrides,
  }) as PluginManifest

const FakeCard: React.FC<{ part: { type: string } }> = ({ part }) =>
  React.createElement("div", null, part.type)

describe("tool-renderer-bridge", () => {
  beforeEach(() => {
    clearAllToolResultRenderers()
  })

  it("registers a card keyed by tool name", async () => {
    const m = manifest({
      toolRenderers: [{ toolName: "demo_lookup", entry: "card.js", export: "DemoCard" }],
    })
    const importer = jest.fn(async () => ({ DemoCard: FakeCard }))

    const result = await registerToolRenderersForPlugin(m, "/plugins/p", { importer })

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(getToolResultRenderer("demo_lookup")?.pluginId).toBe("p")
  })

  it("resolves the namespaced provider form onto the same card", async () => {
    const m = manifest({
      toolRenderers: [{ toolName: "demo_lookup", entry: "card.js", export: "DemoCard" }],
    })
    await registerToolRenderersForPlugin(m, "/plugins/p", {
      importer: async () => ({ DemoCard: FakeCard }),
    })

    expect(getToolResultRenderer("tool-mcp__cognia-plugin-tools__demo_lookup")?.pluginId).toBe("p")
  })

  it("no-ops without a toolRenderers field", async () => {
    const result = await registerToolRenderersForPlugin(manifest({}), "/plugins/p", {
      importer: jest.fn(),
    })
    expect(result).toEqual({ registered: 0, errors: [] })
  })

  it("reports a missing toolName instead of registering an unreachable card", async () => {
    const m = manifest({
      toolRenderers: [{ toolName: "  ", entry: "card.js", export: "DemoCard" }],
    })
    const result = await registerToolRenderersForPlugin(m, "/plugins/p", {
      importer: async () => ({ DemoCard: FakeCard }),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain("toolName")
    expect(listToolResultRenderers()).toHaveLength(0)
  })

  it("reports a non-string toolName from a hand-written manifest", async () => {
    const m = manifest({
      toolRenderers: [
        { toolName: undefined as unknown as string, entry: "card.js", export: "DemoCard" },
      ],
    })
    const result = await registerToolRenderersForPlugin(m, "/plugins/p", {
      importer: async () => ({ DemoCard: FakeCard }),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain("toolName")
  })

  it("falls back to a real dynamic import when no importer is injected", async () => {
    // Exercises the production default: with no options argument the bridge
    // uses its own `import()`, which for a nonexistent install root fails and
    // is reported rather than thrown.
    const m = manifest({
      toolRenderers: [{ toolName: "demo_lookup", entry: "card.js", export: "DemoCard" }],
    })

    const result = await registerToolRenderersForPlugin(m, "/plugins/does-not-exist")

    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].toolName).toBe("demo_lookup")
  })

  it("reports an entry that does not export the named component", async () => {
    const m = manifest({
      toolRenderers: [{ toolName: "demo_lookup", entry: "card.js", export: "Missing" }],
    })
    const result = await registerToolRenderersForPlugin(m, "/plugins/p", {
      importer: async () => ({ DemoCard: FakeCard }),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0]).toMatchObject({ pluginId: "p", toolName: "demo_lookup" })
    expect(result.errors[0].message).toContain("Missing")
  })

  it("reports an importer failure without aborting the remaining entries", async () => {
    const m = manifest({
      toolRenderers: [
        { toolName: "broken", entry: "bad.js", export: "X" },
        { toolName: "fine", entry: "good.js", export: "DemoCard" },
      ],
    })
    const importer = jest.fn(async (entry: string) => {
      if (entry.includes("bad.js")) throw new Error("boom")
      return { DemoCard: FakeCard }
    })

    const result = await registerToolRenderersForPlugin(m, "/plugins/p", { importer })

    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(getToolResultRenderer("fine")?.pluginId).toBe("p")
  })

  it("does not double-register when the plugin is re-enabled", async () => {
    const m = manifest({
      toolRenderers: [{ toolName: "demo_lookup", entry: "card.js", export: "DemoCard" }],
    })
    const importer = async () => ({ DemoCard: FakeCard })

    await registerToolRenderersForPlugin(m, "/plugins/p", { importer })
    await registerToolRenderersForPlugin(m, "/plugins/p", { importer })

    expect(listToolResultRenderers()).toHaveLength(1)
  })

  it("unregisters everything the plugin owns on disable", async () => {
    const m = manifest({
      toolRenderers: [{ toolName: "demo_lookup", entry: "card.js", export: "DemoCard" }],
    })
    await registerToolRenderersForPlugin(m, "/plugins/p", {
      importer: async () => ({ DemoCard: FakeCard }),
    })

    unregisterToolRenderersForPlugin("p")

    expect(getToolResultRenderer("demo_lookup")).toBeUndefined()
  })
})
