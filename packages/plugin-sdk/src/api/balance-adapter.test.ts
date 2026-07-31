import * as sdk from "./balance-adapter"
import type { PluginBalanceAdapterDef } from "./balance-adapter"

describe("plugin-sdk api/balance-adapter", () => {
  it("exposes the authoring helper and dynamic registry functions", () => {
    expect(typeof sdk.defineBalanceAdapter).toBe("function")
    expect(typeof sdk.registerBalanceAdapter).toBe("function")
    expect(typeof sdk.unregisterBalanceAdapterById).toBe("function")
    expect(typeof sdk.unregisterBalanceAdaptersByPlugin).toBe("function")
    expect(typeof sdk.getBalanceAdapter).toBe("function")
    expect(typeof sdk.getBalanceAdapterEntry).toBe("function")
    expect(typeof sdk.listBalanceAdapterIds).toBe("function")
    expect(typeof sdk.listBalanceAdapterEntries).toBe("function")
  })

  it("re-exports the balance adapter definition type", () => {
    const assertType = <_T extends PluginBalanceAdapterDef>(): void => undefined
    expect(assertType).toBeDefined()
  })
})
