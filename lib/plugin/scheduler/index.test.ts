import * as scheduler from "./index"

describe("lib/plugin/scheduler re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "registerPluginTaskHandler",
      "unregisterPluginTaskHandler",
      "getPluginTaskHandler",
      "hasPluginTaskHandler",
      "getPluginTaskHandlerNames",
      "clearPluginTaskHandlers",
    ] as const

    for (const name of expected) {
      expect(scheduler).toHaveProperty(name)
      expect((scheduler as Record<string, unknown>)[name]).toBeDefined()
    }
  })
})
