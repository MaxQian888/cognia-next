import {
  __resetDeploymentFiltersForTesting,
  DEFAULT_FILTER_CHAIN,
  getDeploymentFilter,
  listDeploymentFilters,
  registerDeploymentFilter,
  unregisterDeploymentFilter,
  unregisterDeploymentFiltersByPlugin,
} from "./filter-registry"
import type { DeploymentFilter } from "@cognia/provider-types/deployment-filter"

const custom = (id: string): DeploymentFilter => ({
  id,
  label: `Custom ${id}`,
  filter: (candidates) => ({ candidates: [...candidates] }),
})

describe("filter-registry", () => {
  afterEach(() => __resetDeploymentFiltersForTesting())

  it("resolves every built-in in the default chain", () => {
    for (const id of DEFAULT_FILTER_CHAIN) {
      expect(getDeploymentFilter(id)?.id).toBe(id)
    }
  })

  it("default chain order matches the historical inline order", () => {
    expect(DEFAULT_FILTER_CHAIN).toEqual([
      "affinity",
      "circuit",
      "context-window",
      "rate-limit",
      "budget",
    ])
  })

  it("registers and resolves a custom filter", () => {
    expect(registerDeploymentFilter(custom("my-filter"), { pluginId: "p1" })).toBe(true)
    expect(getDeploymentFilter("my-filter")?.label).toBe("Custom my-filter")
  })

  it("rejects built-in id collisions", () => {
    expect(registerDeploymentFilter(custom("circuit"))).toBe(false)
    // The built-in stays authoritative.
    expect(getDeploymentFilter("circuit")?.label).toBe("Circuit breaker")
  })

  it("unregisters by id and by plugin", () => {
    registerDeploymentFilter(custom("f1"), { pluginId: "p1" })
    registerDeploymentFilter(custom("f2"), { pluginId: "p1" })
    registerDeploymentFilter(custom("f3"), { pluginId: "p2" })
    expect(unregisterDeploymentFilter("f1")).toBe(true)
    expect(unregisterDeploymentFiltersByPlugin("p1")).toBe(1) // f2
    expect(getDeploymentFilter("f3")).toBeDefined()
    expect(getDeploymentFilter("f2")).toBeUndefined()
  })

  it("lists built-ins first, then customs with plugin attribution", () => {
    registerDeploymentFilter(custom("zz"), { pluginId: "p1" })
    const all = listDeploymentFilters()
    const builtInCount = all.filter((f) => f.builtIn).length
    expect(builtInCount).toBe(5)
    expect(all.slice(0, builtInCount).every((f) => f.builtIn)).toBe(true)
    const zz = all.find((f) => f.id === "zz")
    expect(zz).toMatchObject({ builtIn: false, pluginId: "p1", label: "Custom zz" })
  })
})
