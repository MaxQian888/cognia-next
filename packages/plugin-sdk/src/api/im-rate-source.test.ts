import * as sdk from "./im-rate-source"
import type { PluginImRateSourceDef } from "./im-rate-source"

describe("plugin-sdk api/im-rate-source", () => {
  it("exposes the authoring helper and dynamic registry functions", () => {
    expect(typeof sdk.defineImRateSource).toBe("function")
    expect(typeof sdk.registerImRateSource).toBe("function")
    expect(typeof sdk.unregisterImRateSourceById).toBe("function")
    expect(typeof sdk.unregisterImRateSourcesByPlugin).toBe("function")
    expect(typeof sdk.getImRateSource).toBe("function")
    expect(typeof sdk.getImRateSourceEntry).toBe("function")
    expect(typeof sdk.listImRateSourceIds).toBe("function")
    expect(typeof sdk.listImRateSourceEntries).toBe("function")
  })

  it("re-exports the IM rate source definition type", () => {
    const assertType = <_T extends PluginImRateSourceDef>(): void => undefined
    expect(assertType).toBeDefined()
  })
})
