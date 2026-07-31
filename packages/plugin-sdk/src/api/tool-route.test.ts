import * as sdk from "./tool-route"
import type {
  DifficultyRoutingSettings,
  PluginToolRouteDef,
  SemanticToolRoutingSettings,
  ToolRouteRecord,
  ToolRoutesBridgeResult,
} from "./tool-route"

describe("plugin-sdk api/tool-route", () => {
  it("exposes the authoring helper, manifest bridge, and persisted route helpers", () => {
    expect(typeof sdk.defineToolRoute).toBe("function")
    expect(typeof sdk.registerToolRoutesForPlugin).toBe("function")
    expect(typeof sdk.unregisterToolRoutesForPlugin).toBe("function")
    expect(typeof sdk.makeToolRouteId).toBe("function")
    expect(typeof sdk.upsertToolRoute).toBe("function")
    expect(typeof sdk.getToolRoute).toBe("function")
    expect(typeof sdk.listToolRoutes).toBe("function")
    expect(typeof sdk.listEnabledToolRoutes).toBe("function")
    expect(typeof sdk.deleteToolRoute).toBe("function")
    expect(typeof sdk.deleteToolRoutesByPlugin).toBe("function")
    expect(typeof sdk.cacheToolRouteEmbeddings).toBe("function")
  })

  it("re-exports semantic tool routing settings defaults and contract types", () => {
    expect(sdk.DEFAULT_SEMANTIC_TOOL_ROUTING.enabled).toBe(false)
    expect(sdk.DEFAULT_DIFFICULTY_ROUTING.enabled).toBe(false)

    const assertTypes = <
      _T extends
        | PluginToolRouteDef
        | ToolRouteRecord
        | SemanticToolRoutingSettings
        | DifficultyRoutingSettings
        | ToolRoutesBridgeResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
