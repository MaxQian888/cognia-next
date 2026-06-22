import * as sdk from "./shared-memory-adapter"
import type { PluginSharedMemoryAdapterDef } from "./shared-memory-adapter"

describe("plugin-sdk api/shared-memory-adapter", () => {
  it("exposes the authoring helper and dynamic registry functions", () => {
    expect(typeof sdk.defineSharedMemoryAdapter).toBe("function")
    expect(typeof sdk.registerSharedMemoryAdapter).toBe("function")
    expect(typeof sdk.unregisterSharedMemoryAdapterById).toBe("function")
    expect(typeof sdk.unregisterSharedMemoryAdaptersByPlugin).toBe("function")
    expect(typeof sdk.getSharedMemoryAdapter).toBe("function")
    expect(typeof sdk.getSharedMemoryAdapterEntry).toBe("function")
    expect(typeof sdk.listSharedMemoryAdapterIds).toBe("function")
    expect(typeof sdk.listSharedMemoryAdapterEntries).toBe("function")
  })

  it("re-exports the shared-memory adapter definition type", () => {
    const assertType = <_T extends PluginSharedMemoryAdapterDef>(): void => undefined
    expect(assertType).toBeDefined()
  })
})
