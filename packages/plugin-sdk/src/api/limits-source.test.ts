import * as sdk from "./limits-source"
import type { PluginLimitsSourceDef } from "./limits-source"

describe("plugin-sdk api/limits-source", () => {
  it("exposes the authoring helper and dynamic registry functions", () => {
    expect(typeof sdk.defineLimitsSource).toBe("function")
    expect(typeof sdk.registerLimitsSource).toBe("function")
    expect(typeof sdk.unregisterLimitsSourceById).toBe("function")
    expect(typeof sdk.unregisterLimitsSourcesByPlugin).toBe("function")
    expect(typeof sdk.getLimitsSource).toBe("function")
    expect(typeof sdk.getLimitsSourceEntry).toBe("function")
    expect(typeof sdk.listLimitsSourceIds).toBe("function")
    expect(typeof sdk.listLimitsSourceEntries).toBe("function")
  })

  it("re-exports the limits source definition type", () => {
    const assertType = <_T extends PluginLimitsSourceDef>(): void => undefined
    expect(assertType).toBeDefined()
  })
})
