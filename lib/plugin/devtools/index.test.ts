import * as devtools from "./index"

describe("lib/plugin/devtools re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "PluginDevTools",
      "setDebugMode",
      "isDebugEnabled",
      "debugLog",
      "getDebugLogs",
      "clearDebugLogs",
      "inspectPlugin",
      "inspectAllPlugins",
      "createMockPluginContext",
      "validateManifestStrict",
      "PluginDebugger",
      "getPluginDebugger",
      "resetPluginDebugger",
      "PluginProfiler",
      "getPluginProfiler",
      "resetPluginProfiler",
      "withProfiling",
      "PluginHotReload",
      "getPluginHotReload",
      "resetPluginHotReload",
      "usePluginHotReload",
      "DevExtensionController",
      "PluginDevServer",
      "getPluginDevServer",
      "resetPluginDevServer",
      "usePluginDevServer",
    ] as const

    for (const name of expected) {
      expect(devtools).toHaveProperty(name)
      expect((devtools as Record<string, unknown>)[name]).toBeDefined()
    }
  })
})
