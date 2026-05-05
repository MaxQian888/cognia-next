import * as lifecycle from "./index"

describe("lib/plugin/lifecycle re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "PluginUpdater",
      "getPluginUpdater",
      "resetPluginUpdater",
      "PluginBackupManager",
      "getPluginBackupManager",
      "resetPluginBackupManager",
      "PluginRollbackManager",
      "getPluginRollbackManager",
      "resetPluginRollbackManager",
    ] as const

    for (const name of expected) {
      expect(lifecycle).toHaveProperty(name)
      expect((lifecycle as Record<string, unknown>)[name]).toBeDefined()
    }
  })
})
