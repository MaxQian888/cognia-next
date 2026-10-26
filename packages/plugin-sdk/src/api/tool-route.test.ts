import * as sdk from "./tool-route"
import type {
  DifficultyRoutingSettings,
  PluginToolRouteDef,
  SemanticToolRoutingSettings,
  ToolRouteRecord,
  ToolRoutesBridgeResult,
} from "./tool-route"

describe("plugin-sdk api/tool-route", () => {
  it("exposes the authoring helper", () => {
    expect(typeof sdk.defineToolRoute).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins contribute through their manifest)", () => {
    expect(sdk).not.toHaveProperty("registerToolRoutesForPlugin")
    expect(sdk).not.toHaveProperty("unregisterToolRoutesForPlugin")
    expect(sdk).not.toHaveProperty("makeToolRouteId")
    expect(sdk).not.toHaveProperty("upsertToolRoute")
    expect(sdk).not.toHaveProperty("getToolRoute")
    expect(sdk).not.toHaveProperty("listToolRoutes")
    expect(sdk).not.toHaveProperty("listEnabledToolRoutes")
    expect(sdk).not.toHaveProperty("deleteToolRoute")
    expect(sdk).not.toHaveProperty("deleteToolRoutesByPlugin")
    expect(sdk).not.toHaveProperty("cacheToolRouteEmbeddings")
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
