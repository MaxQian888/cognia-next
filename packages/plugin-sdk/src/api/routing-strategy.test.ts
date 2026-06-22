import * as sdk from "./routing-strategy"
import type {
  PluginRoutingStrategyDef,
  PluginRoutingStrategyFactory,
  PluginRoutingStrategySelectorLike,
  RoutingStrategiesBridgeOptions,
  RoutingStrategiesBridgeResult,
} from "./routing-strategy"

describe("plugin-sdk api/routing-strategy", () => {
  it("exposes the authoring helper, manifest bridge, and dynamic registry", () => {
    expect(typeof sdk.defineRoutingStrategy).toBe("function")
    expect(typeof sdk.registerRoutingStrategiesForPlugin).toBe("function")
    expect(typeof sdk.unregisterRoutingStrategiesForPlugin).toBe("function")
    expect(typeof sdk.registerRoutingStrategy).toBe("function")
    expect(typeof sdk.unregisterRoutingStrategy).toBe("function")
    expect(typeof sdk.unregisterRoutingStrategiesByPlugin).toBe("function")
    expect(typeof sdk.getRoutingStrategy).toBe("function")
    expect(typeof sdk.listRoutingStrategies).toBe("function")
  })

  it("re-exports routing strategy manifest and bridge types", () => {
    const assertTypes = <
      _T extends
        | PluginRoutingStrategyDef
        | PluginRoutingStrategyFactory
        | PluginRoutingStrategySelectorLike
        | RoutingStrategiesBridgeOptions
        | RoutingStrategiesBridgeResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
