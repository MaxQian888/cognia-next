import * as bridge from "./index"

describe("lib/plugin/bridge re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "PluginA2UIBridge",
      "PluginToolsBridge",
      "PluginWorkflowIntegration",
      "getPluginWorkflowIntegration",
      "resetPluginWorkflowIntegration",
      "usePluginWorkflowIntegration",
    ] as const

    for (const name of expected) {
      expect(bridge).toHaveProperty(name)
      expect((bridge as Record<string, unknown>)[name]).toBeDefined()
    }
  })
})
