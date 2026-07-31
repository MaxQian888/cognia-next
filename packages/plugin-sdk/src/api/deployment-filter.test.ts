import * as sdk from "./deployment-filter"
import type {
  DeploymentFiltersBridgeOptions,
  DeploymentFiltersBridgeResult,
  PluginDeploymentFilterDef,
  PluginDeploymentFilterFactory,
  PluginDeploymentFilterLike,
} from "./deployment-filter"

describe("plugin-sdk api/deployment-filter", () => {
  it("exposes the authoring helper, manifest bridge, and dynamic registry", () => {
    expect(typeof sdk.defineDeploymentFilter).toBe("function")
    expect(typeof sdk.registerDeploymentFiltersForPlugin).toBe("function")
    expect(typeof sdk.unregisterDeploymentFiltersForPlugin).toBe("function")
    expect(typeof sdk.registerDeploymentFilter).toBe("function")
    expect(typeof sdk.unregisterDeploymentFilter).toBe("function")
    expect(typeof sdk.unregisterDeploymentFiltersByPlugin).toBe("function")
    expect(typeof sdk.getDeploymentFilter).toBe("function")
    expect(typeof sdk.listDeploymentFilters).toBe("function")
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
