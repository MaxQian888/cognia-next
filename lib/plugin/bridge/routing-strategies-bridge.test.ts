import {
  registerRoutingStrategiesForPlugin,
  unregisterRoutingStrategiesForPlugin,
} from "./routing-strategies-bridge"
import {
  getRoutingStrategy,
  __resetRoutingStrategiesForTesting,
} from "@cognia/provider-routing/strategy-registry"
import { makeTelemetrySnapshot } from "@cognia/provider-routing/strategies/built-in"
import type { PluginManifest } from "@/types/plugin"

const MANIFEST = {
  id: "router-plugin",
  name: "Router Plugin",
  version: "0.1.0",
  description: "d",
  type: "frontend",
  capabilities: [],
  routingStrategies: [
    { id: "always-last", label: "Always last", entry: "src/strategy.js", export: "createStrategy" },
  ],
} as unknown as PluginManifest

const telemetry = makeTelemetrySnapshot({
  getHealthMetrics: () => undefined,
  getPricing: () => undefined,
})

const ENTRIES = [
  { providerId: "a", modelId: "m-a" },
  { providerId: "b", modelId: "m-b" },
]

afterEach(() => {
  __resetRoutingStrategiesForTesting()
})

describe("routing-strategies-bridge python backend", () => {
  it("registers a python-backed strategy without importing any JS", async () => {
    const importer = jest.fn()
    const manifest = {
      ...(MANIFEST as unknown as Record<string, unknown>),
      type: "python",
      pythonMain: "main.py",
      routingStrategies: [{ id: "py-router", label: "Py router" }],
    } as unknown as PluginManifest

    const result = await registerRoutingStrategiesForPlugin(manifest, "/plugins/router", {
      importer,
    })

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).not.toHaveBeenCalled()
    expect(getRoutingStrategy("router-plugin:py-router")).toBeDefined()
    unregisterRoutingStrategiesForPlugin("router-plugin")
  })

  it("reports a JS-backed strategy that omits entry/export", async () => {
    const manifest = {
      ...(MANIFEST as unknown as Record<string, unknown>),
      routingStrategies: [{ id: "broken", label: "Broken" }],
    } as unknown as PluginManifest

    const result = await registerRoutingStrategiesForPlugin(manifest, "/plugins/router", {
      importer: jest.fn(),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0]!.message).toMatch(/must declare both "entry" and "export"/)
  })
})

describe("routing-strategies-bridge", () => {
  it("imports the factory and registers the selector under the namespaced id", async () => {
    const factory = jest.fn(async (ctx: { strategyId: string }) => ({
      select: (entries: typeof ENTRIES) => entries[entries.length - 1] ?? null,
      seenId: ctx.strategyId,
    }))
    const importer = jest.fn(async () => ({ createStrategy: factory }))

    const result = await registerRoutingStrategiesForPlugin(MANIFEST, "/plugins/router-plugin", {
      importer,
    })
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).toHaveBeenCalledWith("/plugins/router-plugin/src/strategy.js")
    expect(factory).toHaveBeenCalledWith({
      strategyId: "router-plugin:always-last",
      pluginId: "router-plugin",
    })

    const selector = getRoutingStrategy("router-plugin:always-last")
    expect(selector?.label).toBe("Always last")
    expect(selector?.select(ENTRIES, telemetry)?.providerId).toBe("b")
  })

  it("collects per-entry errors without blocking other strategies", async () => {
    const manifest = {
      ...MANIFEST,
      routingStrategies: [
        { id: "broken", label: "Broken", entry: "src/missing.js", export: "nope" },
        { id: "good", label: "Good", entry: "src/ok.js", export: "make" },
      ],
    } as unknown as PluginManifest
    const importer = jest.fn(async (entry: string) => {
      if (entry.includes("missing")) return {}
      return { make: () => ({ select: (e: typeof ENTRIES) => e[0] ?? null }) }
    })

    const result = await registerRoutingStrategiesForPlugin(manifest, "/p", { importer })
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ strategyId: "broken" })
    expect(getRoutingStrategy("router-plugin:good")).toBeDefined()
    expect(getRoutingStrategy("router-plugin:broken")).toBeUndefined()
  })

  it("rejects factories that do not return a { select } selector", async () => {
    const importer = jest.fn(async () => ({ createStrategy: () => ({ notSelect: true }) }))
    const result = await registerRoutingStrategiesForPlugin(MANIFEST, "/p", { importer })
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain("did not return a { select }")
  })

  it("unregister drops every strategy of the plugin; re-enable replaces", async () => {
    const importer = jest.fn(async () => ({
      createStrategy: () => ({ select: (e: typeof ENTRIES) => e[0] ?? null }),
    }))
    await registerRoutingStrategiesForPlugin(MANIFEST, "/p", { importer })
    expect(getRoutingStrategy("router-plugin:always-last")).toBeDefined()
    unregisterRoutingStrategiesForPlugin("router-plugin")
    expect(getRoutingStrategy("router-plugin:always-last")).toBeUndefined()

    // Re-enable path: register twice is idempotent (clears prior first).
    await registerRoutingStrategiesForPlugin(MANIFEST, "/p", { importer })
    await registerRoutingStrategiesForPlugin(MANIFEST, "/p", { importer })
    expect(getRoutingStrategy("router-plugin:always-last")).toBeDefined()
  })

  it("manifests without routingStrategies are a fast no-op", async () => {
    const importer = jest.fn()
    const result = await registerRoutingStrategiesForPlugin(
      { ...MANIFEST, routingStrategies: undefined } as PluginManifest,
      "/p",
      { importer }
    )
    expect(result).toEqual({ registered: 0, errors: [] })
    expect(importer).not.toHaveBeenCalled()
  })
})
