import * as sdk from "./routing-strategy"
import type {
  PluginRoutingStrategyDef,
  PluginRoutingStrategyFactory,
  PluginRoutingStrategySelectorLike,
  RoutingStrategiesBridgeOptions,
  RoutingStrategiesBridgeResult,
} from "./routing-strategy"

describe("plugin-sdk api/routing-strategy", () => {
  it("exposes the authoring helper and the dynamic registry", () => {
    expect(typeof sdk.defineRoutingStrategy).toBe("function")
    expect(typeof sdk.registerRoutingStrategy).toBe("function")
    expect(typeof sdk.unregisterRoutingStrategy).toBe("function")
    expect(typeof sdk.unregisterRoutingStrategiesByPlugin).toBe("function")
    expect(typeof sdk.getRoutingStrategy).toBe("function")
    expect(typeof sdk.listRoutingStrategies).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins contribute through their manifest)", () => {
    expect(sdk).not.toHaveProperty("registerRoutingStrategiesForPlugin")
    expect(sdk).not.toHaveProperty("unregisterRoutingStrategiesForPlugin")
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
