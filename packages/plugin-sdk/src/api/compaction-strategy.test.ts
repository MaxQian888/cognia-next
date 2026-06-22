import * as sdk from "./compaction-strategy"
import type { PluginCompactionStrategyDef } from "./compaction-strategy"

describe("plugin-sdk api/compaction-strategy", () => {
  it("exposes the authoring helper and dynamic registry functions", () => {
    expect(typeof sdk.defineCompactionStrategy).toBe("function")
    expect(typeof sdk.registerCompactionStrategy).toBe("function")
    expect(typeof sdk.unregisterCompactionStrategyById).toBe("function")
    expect(typeof sdk.unregisterCompactionStrategiesByPlugin).toBe("function")
    expect(typeof sdk.getCompactionStrategy).toBe("function")
    expect(typeof sdk.getCompactionStrategyEntry).toBe("function")
    expect(typeof sdk.listCompactionStrategyIds).toBe("function")
    expect(typeof sdk.listCompactionStrategyEntries).toBe("function")
  })

  it("re-exports the compaction strategy definition type", () => {
    const assertType = <_T extends PluginCompactionStrategyDef>(): void => undefined
    expect(assertType).toBeDefined()
  })
})
