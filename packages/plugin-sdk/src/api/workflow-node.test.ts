import * as sdk from "./workflow-node"
import type {
  NodeExecuteFn,
  NodeExecutorRegistration,
  NodeRegistryEvent,
  NodeRegistryListener,
  PluginNodeDef,
  PluginNodeExecuteFn,
} from "./workflow-node"

describe("plugin-sdk api/workflow-node", () => {
  it("exposes the authoring helper and workflow node executor registry", () => {
    expect(typeof sdk.defineWorkflowNode).toBe("function")
    expect(typeof sdk.registerNodeExecutor).toBe("function")
    expect(typeof sdk.unregisterNodeExecutor).toBe("function")
    expect(typeof sdk.getExecutor).toBe("function")
    expect(typeof sdk.listRegisteredKinds).toBe("function")
    expect(typeof sdk.subscribeNodeRegistry).toBe("function")
  })

  it("re-exports workflow node definition and registry types", () => {
    const assertTypes = <
      _T extends
        | PluginNodeDef
        | PluginNodeExecuteFn
        | NodeExecuteFn
        | NodeExecutorRegistration
        | NodeRegistryEvent
        | NodeRegistryListener,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
