import * as sdk from "./deployment-filter"
import type {
  DeploymentFiltersBridgeOptions,
  DeploymentFiltersBridgeResult,
  PluginDeploymentFilterDef,
  PluginDeploymentFilterFactory,
  PluginDeploymentFilterLike,
} from "./deployment-filter"

describe("plugin-sdk api/deployment-filter", () => {
  it("exposes the authoring helper and the dynamic registry", () => {
    expect(typeof sdk.defineDeploymentFilter).toBe("function")
    expect(typeof sdk.registerDeploymentFilter).toBe("function")
    expect(typeof sdk.unregisterDeploymentFilter).toBe("function")
    expect(typeof sdk.unregisterDeploymentFiltersByPlugin).toBe("function")
    expect(typeof sdk.getDeploymentFilter).toBe("function")
    expect(typeof sdk.listDeploymentFilters).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins contribute through their manifest)", () => {
    expect(sdk).not.toHaveProperty("registerDeploymentFiltersForPlugin")
    expect(sdk).not.toHaveProperty("unregisterDeploymentFiltersForPlugin")
  })

  it("re-exports deployment filter manifest and bridge types", () => {
    const assertTypes = <
      _T extends
        | PluginDeploymentFilterDef
        | PluginDeploymentFilterFactory
        | PluginDeploymentFilterLike
        | DeploymentFiltersBridgeOptions
        | DeploymentFiltersBridgeResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
