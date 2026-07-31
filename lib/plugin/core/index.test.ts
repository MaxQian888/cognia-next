import * as core from "./index"

describe("lib/plugin/core re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "PluginManager",
      "getPluginManager",
      "initializePluginManager",
      "PluginLoader",
      "PluginRegistry",
      "createPluginContext",
      "createFullPluginContext",
      "isFullPluginContext",
      "validatePluginManifest",
      "validatePluginConfig",
      "parseManifest",
      "evaluatePluginCompatibility",
      "buildExtensionDescriptor",
      "derivePluginInstallRootKind",
      "createPluginSystemLogger",
      "pluginLogger",
      "loggers",
      "createPluginVerificationSnapshot",
    ] as const

    for (const name of expected) {
      expect(core).toHaveProperty(name)
      expect((core as Record<string, unknown>)[name]).toBeDefined()
    }
  })
})
