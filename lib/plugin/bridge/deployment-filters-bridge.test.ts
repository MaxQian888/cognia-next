import {
  registerDeploymentFiltersForPlugin,
  unregisterDeploymentFiltersForPlugin,
} from "./deployment-filters-bridge"
import {
  getDeploymentFilter,
  __resetDeploymentFiltersForTesting,
} from "@cognia/provider-routing/filter-registry"
import type { FilterContext } from "@cognia/provider-types/deployment-filter"
import type { PluginManifest } from "@/types/plugin"

const MANIFEST = {
  id: "filter-plugin",
  name: "Filter Plugin",
  version: "0.1.0",
  description: "d",
  type: "frontend",
  capabilities: [],
  deploymentFilters: [
    { id: "drop-first", label: "Drop first", entry: "src/filter.js", export: "createFilter" },
  ],
} as unknown as PluginManifest

describe("deployment-filters-bridge python backend", () => {
  it("registers a python-backed filter without importing any JS", async () => {
    const importer = jest.fn()
    const manifest = {
      ...(MANIFEST as unknown as Record<string, unknown>),
      type: "python",
      pythonMain: "main.py",
      deploymentFilters: [{ id: "py-filter", label: "Py filter" }],
    } as unknown as PluginManifest

    const result = await registerDeploymentFiltersForPlugin(manifest, "/plugins/filter", {
      importer,
    })

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).not.toHaveBeenCalled()
    expect(getDeploymentFilter("filter-plugin:py-filter")).toBeDefined()
    unregisterDeploymentFiltersForPlugin("filter-plugin")
  })

  it("reports a JS-backed filter that omits entry/export", async () => {
    const manifest = {
      ...(MANIFEST as unknown as Record<string, unknown>),
      deploymentFilters: [{ id: "broken", label: "Broken" }],
    } as unknown as PluginManifest

    const result = await registerDeploymentFiltersForPlugin(manifest, "/plugins/filter", {
      importer: jest.fn(),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0]!.message).toMatch(/must declare both "entry" and "export"/)
  })
})

const ENTRIES = [
  { providerId: "a", modelId: "m-a" },
  { providerId: "b", modelId: "m-b" },
]

const CTX: FilterContext = {
  telemetry: {
    getHealthMetrics: () => undefined,
    getPricing: () => undefined,
    getInFlight: () => 0,
    now: () => 0,
  },
  getCircuitBreakerState: () => "closed",
  isAvailable: () => true,
  constraints: [],
  now: () => 0,
}

afterEach(() => {
  __resetDeploymentFiltersForTesting()
})

describe("deployment-filters-bridge", () => {
  it("imports the factory and registers the filter under the namespaced id", async () => {
    const factory = jest.fn(async (ctx: { filterId: string }) => ({
      filter: (candidates: typeof ENTRIES) => ({ candidates: candidates.slice(1) }),
      seenId: ctx.filterId,
    }))
    const importer = jest.fn(async () => ({ createFilter: factory }))

    const result = await registerDeploymentFiltersForPlugin(MANIFEST, "/plugins/filter-plugin", {
      importer,
    })
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).toHaveBeenCalledWith("/plugins/filter-plugin/src/filter.js")
    expect(factory).toHaveBeenCalledWith({
      filterId: "filter-plugin:drop-first",
      pluginId: "filter-plugin",
    })

    const filter = getDeploymentFilter("filter-plugin:drop-first")
    expect(filter?.label).toBe("Drop first")
    expect(
      filter?.filter(ENTRIES, { alias: "x" }, CTX).candidates.map((e) => e.providerId)
    ).toEqual(["b"])
  })

  it("collects per-entry errors without blocking other filters", async () => {
    const manifest = {
      ...MANIFEST,
      deploymentFilters: [
        { id: "broken", label: "Broken", entry: "src/missing.js", export: "nope" },
        { id: "good", label: "Good", entry: "src/ok.js", export: "make" },
      ],
    } as unknown as PluginManifest
    const importer = jest.fn(async (entry: string) => {
      if (entry.includes("missing")) return {}
      return { make: () => ({ filter: (e: typeof ENTRIES) => ({ candidates: [...e] }) }) }
    })

    const result = await registerDeploymentFiltersForPlugin(manifest, "/p", { importer })
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ filterId: "broken" })
    expect(getDeploymentFilter("filter-plugin:good")).toBeDefined()
    expect(getDeploymentFilter("filter-plugin:broken")).toBeUndefined()
  })

  it("rejects factories that do not return a { filter }", async () => {
    const importer = jest.fn(async () => ({ createFilter: () => ({ notFilter: true }) }))
    const result = await registerDeploymentFiltersForPlugin(MANIFEST, "/p", { importer })
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain("did not return a { filter }")
  })

  it("unregister drops every filter of the plugin; re-enable replaces", async () => {
    const importer = jest.fn(async () => ({
      createFilter: () => ({ filter: (e: typeof ENTRIES) => ({ candidates: [...e] }) }),
    }))
    await registerDeploymentFiltersForPlugin(MANIFEST, "/p", { importer })
    expect(getDeploymentFilter("filter-plugin:drop-first")).toBeDefined()
    unregisterDeploymentFiltersForPlugin("filter-plugin")
    expect(getDeploymentFilter("filter-plugin:drop-first")).toBeUndefined()

    // Re-enable path: register twice is idempotent (clears prior first).
    await registerDeploymentFiltersForPlugin(MANIFEST, "/p", { importer })
    await registerDeploymentFiltersForPlugin(MANIFEST, "/p", { importer })
    expect(getDeploymentFilter("filter-plugin:drop-first")).toBeDefined()
  })

  it("manifests without deploymentFilters are a fast no-op", async () => {
    const importer = jest.fn()
    const result = await registerDeploymentFiltersForPlugin(
      { ...MANIFEST, deploymentFilters: undefined } as PluginManifest,
      "/p",
      { importer }
    )
    expect(result).toEqual({ registered: 0, errors: [] })
    expect(importer).not.toHaveBeenCalled()
  })
})
