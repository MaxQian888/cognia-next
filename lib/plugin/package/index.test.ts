import * as pkg from "./index"

describe("lib/plugin/package re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "buildExtensionCatalogEntry",
      "PluginMarketplace",
      "LocalPluginSource",
      "getPluginMarketplace",
      "resetPluginMarketplace",
      "usePluginMarketplace",
      "DependencyResolver",
      "getDependencyResolver",
      "resetDependencyResolver",
      "parseVersion",
      "compareVersions",
      "parseConstraint",
      "satisfiesConstraint",
      "ConflictDetector",
      "getConflictDetector",
      "resetConflictDetector",
    ] as const

    for (const name of expected) {
      expect(pkg).toHaveProperty(name)
      expect((pkg as Record<string, unknown>)[name]).toBeDefined()
    }
  })
})
