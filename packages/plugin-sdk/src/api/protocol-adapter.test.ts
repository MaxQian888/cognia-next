import * as sdk from "./protocol-adapter"
import type {
  CodeProtocolAdapterFactory,
  CodeProtocolAdapterLike,
  PluginProtocolAdapterDef,
  ProtocolAdapterSpec,
  ProtocolAdaptersBridgeOptions,
  ProtocolAdaptersBridgeResult,
} from "./protocol-adapter"

describe("plugin-sdk api/protocol-adapter", () => {
  it("exposes the authoring helper, manifest bridge, registry, and code executors", () => {
    expect(typeof sdk.defineProtocolAdapter).toBe("function")
    expect(typeof sdk.registerProtocolAdaptersForPlugin).toBe("function")
    expect(typeof sdk.unregisterProtocolAdaptersForPlugin).toBe("function")
    expect(typeof sdk.registerProtocolAdapter).toBe("function")
    expect(typeof sdk.unregisterProtocolAdapter).toBe("function")
    expect(typeof sdk.unregisterProtocolAdaptersByPlugin).toBe("function")
    expect(typeof sdk.listProtocolAdapters).toBe("function")
    expect(typeof sdk.getProtocolAdapter).toBe("function")
    expect(typeof sdk.registerCodeAdapterExecutor).toBe("function")
    expect(typeof sdk.getCodeAdapterExecutor).toBe("function")
    expect(typeof sdk.unregisterCodeAdapterExecutor).toBe("function")
    expect(typeof sdk.unregisterCodeAdapterExecutorsByPlugin).toBe("function")
  })

  it("re-exports protocol adapter manifest, bridge, and executor types", () => {
    const assertTypes = <
      _T extends
        | PluginProtocolAdapterDef
        | ProtocolAdapterSpec
        | CodeProtocolAdapterLike
        | CodeProtocolAdapterFactory
        | ProtocolAdaptersBridgeOptions
        | ProtocolAdaptersBridgeResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
