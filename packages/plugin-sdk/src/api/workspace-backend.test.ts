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
  it("exposes the authoring helper, manifest bridge, plugin API, and host registry", () => {
    expect(typeof sdk.defineWorkspaceBackend).toBe("function")
    expect(typeof sdk.registerWorkspaceBackendsForPlugin).toBe("function")
    expect(typeof sdk.unregisterWorkspaceBackendsForPlugin).toBe("function")
    expect(typeof sdk.createWorkspaceAPI).toBe("function")
    expect(typeof sdk.clearWorkspaceBackendsForPluginContext).toBe("function")
    expect(typeof sdk.registerWorkspaceBackend).toBe("function")
    expect(typeof sdk.unregisterWorkspaceBackend).toBe("function")
    expect(typeof sdk.getWorkspaceBackend).toBe("function")
    expect(typeof sdk.hasWorkspaceBackend).toBe("function")
    expect(typeof sdk.listWorkspaceBackends).toBe("function")
    expect(typeof sdk.clearWorkspaceBackendsForPlugin).toBe("function")
    expect(typeof sdk.subscribeWorkspaceBackendRegistry).toBe("function")
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
