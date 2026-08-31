import * as sdk from "./automation"
import type { PluginAutomationAPI } from "./automation"

describe("plugin-sdk api/automation", () => {
  it("keeps the host runtime factory off the portable author surface", () => {
    expect(sdk).not.toHaveProperty("createAutomationAPI")
  })

  it("re-exports the automation runtime API type", () => {
    const assertTypes = <_T extends PluginAutomationAPI>(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
