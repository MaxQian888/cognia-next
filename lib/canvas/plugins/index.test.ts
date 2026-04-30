/**
 * @jest-environment jsdom
 *
 * Smoke test for the canvas/plugins barrel — re-exports the plugin manager
 * class + singleton.
 */

import * as plugins from "./index"

describe("canvas/plugins barrel exports", () => {
  it("re-exports CanvasPluginManager + pluginManager singleton", () => {
    expect(typeof plugins.CanvasPluginManager).toBe("function")
    expect(plugins.pluginManager).toBeInstanceOf(plugins.CanvasPluginManager)
  })

  it("exposes the named CanvasPluginManager + pluginManager exports", () => {
    // The barrel uses `export *` which does not forward the default export,
    // so consumers should use the named class.
    expect(plugins.CanvasPluginManager).toBeDefined()
    expect(plugins.pluginManager).toBeInstanceOf(plugins.CanvasPluginManager)
  })
})
