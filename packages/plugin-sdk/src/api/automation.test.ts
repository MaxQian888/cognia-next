import * as sdk from "./automation"
import type { PluginAutomationAPI } from "./automation"

describe("plugin-sdk api/automation", () => {
  it("exposes the automation runtime API factory", () => {
    expect(typeof sdk.createAutomationAPI).toBe("function")
  })

  it("re-exports the automation runtime API type", () => {
    const assertTypes = <_T extends PluginAutomationAPI>(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
