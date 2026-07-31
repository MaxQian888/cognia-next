import { defineDeploymentFilter } from "./define-deployment-filter"

describe("defineDeploymentFilter", () => {
  it("returns the deployment filter definition unchanged", () => {
    const def = {
      id: "region",
      label: "Region Filter",
      description: "Drops deployments outside a configured region.",
      entry: "src/routing/region-filter.ts",
      export: "createRegionFilter",
    }

    expect(defineDeploymentFilter(def)).toBe(def)
  })
})
