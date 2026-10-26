import * as sdk from "./workspace-backend"
import type {
  PluginWorkspaceAPI,
  PluginWorkspaceBackendDef,
  PluginWorkspaceBackendFactory,
  PluginWorkspaceBackendRegistration,
  WorkspaceBackendBridgeOptions,
  WorkspaceBackendBridgeResult,
  WorkspaceBackendRegistration,
  WorkspaceBackendRegistryEvent,
  WorkspaceProvider,
} from "./workspace-backend"

describe("plugin-sdk api/workspace-backend", () => {
  it("exposes the authoring helper and the workspace-backend registry", () => {
    expect(typeof sdk.defineWorkspaceBackend).toBe("function")
    expect(typeof sdk.registerWorkspaceBackend).toBe("function")
    expect(typeof sdk.unregisterWorkspaceBackend).toBe("function")
    expect(typeof sdk.getWorkspaceBackend).toBe("function")
    expect(typeof sdk.hasWorkspaceBackend).toBe("function")
    expect(typeof sdk.listWorkspaceBackends).toBe("function")
    expect(typeof sdk.clearWorkspaceBackendsForPlugin).toBe("function")
    expect(typeof sdk.subscribeWorkspaceBackendRegistry).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins reach it through ctx.workspace)", () => {
    expect(sdk).not.toHaveProperty("registerWorkspaceBackendsForPlugin")
    expect(sdk).not.toHaveProperty("unregisterWorkspaceBackendsForPlugin")
    expect(sdk).not.toHaveProperty("createWorkspaceAPI")
    expect(sdk).not.toHaveProperty("clearWorkspaceBackendsForPluginContext")
  })

  it("re-exports workspace backend bridge, registry, and provider types", () => {
    const assertTypes = <
      _T extends
        | PluginWorkspaceBackendDef
        | PluginWorkspaceBackendFactory
        | PluginWorkspaceBackendRegistration
        | PluginWorkspaceAPI
        | WorkspaceBackendBridgeOptions
        | WorkspaceBackendBridgeResult
        | WorkspaceBackendRegistration
        | WorkspaceBackendRegistryEvent
        | WorkspaceProvider,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
