import * as sdk from "./companion"
import type { CompanionServerStatus, PluginCompanionAPI } from "./companion"

describe("plugin-sdk api/companion", () => {
  it("exposes the companion runtime API factory", () => {
    expect(typeof sdk.createCompanionAPI).toBe("function")
  })

  it("re-exports companion runtime API and status types", () => {
    const assertTypes = <_T extends PluginCompanionAPI | CompanionServerStatus>(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
