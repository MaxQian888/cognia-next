import * as sdk from "./external-agent-adapter"
import type {
  ExternalAgentAdaptersBridgeOptions,
  ExternalAgentAdaptersBridgeResult,
  PluginExternalAgentAdapterDef,
  ProtocolAdapter,
  ProtocolAdapterFactory,
  ProtocolAdapterRegistryChange,
  SessionCreateOptions,
} from "./external-agent-adapter"

describe("plugin-sdk api/external-agent-adapter", () => {
  it("exposes the authoring helper, manifest bridge, and protocol adapter registry", () => {
    expect(typeof sdk.defineExternalAgentAdapter).toBe("function")
    expect(typeof sdk.registerExternalAgentAdaptersForPlugin).toBe("function")
    expect(typeof sdk.unregisterExternalAgentAdaptersForPlugin).toBe("function")
    expect(typeof sdk.registerPluginProtocolAdapter).toBe("function")
    expect(typeof sdk.unregisterPluginProtocolAdaptersByPlugin).toBe("function")
    expect(typeof sdk.getPluginProtocolAdapterOwner).toBe("function")
    expect(typeof sdk.getPluginProtocolAdapterProtocols).toBe("function")
    expect(typeof sdk.listPluginProtocolAdapters).toBe("function")
    expect(typeof sdk.onProtocolAdapterRegistryChange).toBe("function")
  })

  it("defineExternalAgentAdapter is a typesafe identity function", () => {
    const def = sdk.defineExternalAgentAdapter({
      id: "demo-protocol",
      label: "Demo Protocol",
      entry: "dist/adapter.js",
      export: "createDemoAdapter",
    })

    expect(def.id).toBe("demo-protocol")
    expect(def.export).toBe("createDemoAdapter")
  })

  it("re-exports external agent adapter bridge and protocol types", () => {
    const assertTypes = <
      _T extends
        | PluginExternalAgentAdapterDef
        | ExternalAgentAdaptersBridgeOptions
        | ExternalAgentAdaptersBridgeResult
        | ProtocolAdapter
        | ProtocolAdapterFactory
        | ProtocolAdapterRegistryChange
        | SessionCreateOptions,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
