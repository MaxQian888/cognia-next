import * as sdk from "./external-agent-adapter"
import type {
  PluginExternalAgentAdapterDef,
  ProtocolAdapter,
  ProtocolAdapterFactory,
  ProtocolAdapterRegistryChange,
  SessionCreateOptions,
} from "./external-agent-adapter"

describe("plugin-sdk api/external-agent-adapter", () => {
  it("exposes portable authoring and adapter runtime helpers", () => {
    expect(typeof sdk.defineExternalAgentAdapter).toBe("function")
    expect(typeof sdk.BaseProtocolAdapter).toBe("function")
    expect(typeof sdk.foldUsageUpdate).toBe("function")
    expect(typeof sdk.mergeTurnUsage).toBe("function")
    expect(typeof sdk.getExternalAgentExecutionBlock).toBe("function")
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

  it("re-exports external-agent adapter protocol types", () => {
    const assertTypes = <
      _T extends
        | PluginExternalAgentAdapterDef
        | ProtocolAdapter
        | ProtocolAdapterFactory
        | ProtocolAdapterRegistryChange
        | SessionCreateOptions,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
