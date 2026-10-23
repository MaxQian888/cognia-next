import * as sdk from "./companion"
import type { CompanionServerStatus, PluginCompanionAPI } from "./companion"

describe("plugin-sdk api/companion", () => {
  it("keeps host wiring off the author surface (plugins reach it through ctx.companion)", () => {
    expect(sdk).not.toHaveProperty("createCompanionAPI")
  })

  it("re-exports companion runtime API and status types", () => {
    const assertTypes = <_T extends PluginCompanionAPI | CompanionServerStatus>(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
