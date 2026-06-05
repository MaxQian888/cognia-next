/**
 * Tests for Plugin Hot Reload
 */

import { PluginHotReload, getPluginHotReload, resetPluginHotReload } from "./hot-reload"

// Mock Tauri APIs
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn().mockResolvedValue({}),
}))

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn().mockResolvedValue(() => {}),
}))

// reloadPythonHost dynamic-imports the manager; default to "not initialized"
// so non-python tests exercise the silent no-op path.
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(() => {
    throw new Error("Plugin manager not initialized")
  }),
}))

const { getPluginManager: getPluginManagerMock } = jest.requireMock(
  "@/lib/plugin/core/manager"
) as { getPluginManager: jest.Mock }

describe("PluginHotReload", () => {
  let reloader: PluginHotReload

  beforeEach(() => {
    resetPluginHotReload()
    reloader = new PluginHotReload()
  })

  afterEach(async () => {
    await reloader.stopWatching()
  })

  describe("Configuration", () => {
    it("should have default configuration", () => {
      const config = reloader.getConfig()

      expect(config.enabled).toBe(false)
      expect(config.debounceMs).toBe(300)
      expect(config.preserveState).toBe(true)
    })

    it("should accept custom configuration", () => {
      const customReloader = new PluginHotReload({
        enabled: true,
        debounceMs: 500,
        preserveState: false,
      })

      const config = customReloader.getConfig()
      expect(config.enabled).toBe(true)
      expect(config.debounceMs).toBe(500)
      expect(config.preserveState).toBe(false)
    })

    it("should update configuration", () => {
      reloader.setConfig({ enabled: true, debounceMs: 1000 })

      const config = reloader.getConfig()
      expect(config.enabled).toBe(true)
      expect(config.debounceMs).toBe(1000)
    })
  })

  describe("Plugin Watching", () => {
    it("should start watching plugins", async () => {
      reloader.setConfig({ enabled: true })

      const plugins = [
        {
          manifest: { id: "plugin-a", name: "Plugin A", version: "1.0.0" },
          path: "/path/to/plugin-a",
          source: "dev" as const,
          status: "enabled" as const,
          config: {},
        },
      ]

      await reloader.startWatching(plugins as never)
      // No error means success
    })

    it("should not start watching when disabled", async () => {
      reloader.setConfig({ enabled: false })

      const plugins = [
        {
          manifest: { id: "plugin-a", name: "Plugin A", version: "1.0.0" },
          path: "/path/to/plugin-a",
          source: "dev" as const,
          status: "enabled" as const,
          config: {},
        },
      ]

      await reloader.startWatching(plugins as never)
      // Should not throw even when disabled
    })

    it("should stop watching", async () => {
      reloader.setConfig({ enabled: true })
      await reloader.stopWatching()
      // No error means success
    })
  })

  describe("Plugin Reloading", () => {
    it("should reload a plugin", async () => {
      const result = await reloader.reloadPlugin("plugin-a")

      expect(result.pluginId).toBe("plugin-a")
      expect(typeof result.success).toBe("boolean")
      expect(typeof result.duration).toBe("number")
    })

    it("should reload all plugins", async () => {
      const results = await reloader.reloadAll()

      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe("Python host cycling", () => {
    afterEach(() => {
      getPluginManagerMock.mockReset()
      getPluginManagerMock.mockImplementation(() => {
        throw new Error("Plugin manager not initialized")
      })
    })

    const fakeManager = (type: string) => ({
      getPlugin: jest.fn(() => ({ manifest: { id: "py-plugin", type } })),
      unloadPythonPlugin: jest.fn().mockResolvedValue(undefined),
      loadPythonPlugin: jest.fn().mockResolvedValue(undefined),
    })

    it("cycles the python host (unload then load) for python plugins", async () => {
      const manager = fakeManager("python")
      getPluginManagerMock.mockImplementation(() => manager)

      const result = await reloader.reloadPlugin("py-plugin")
      expect(result.success).toBe(true)
      expect(manager.unloadPythonPlugin).toHaveBeenCalledWith("py-plugin")
      expect(manager.loadPythonPlugin).toHaveBeenCalledWith("py-plugin")
      // Order: unload strictly before load.
      const unloadOrder = manager.unloadPythonPlugin.mock.invocationCallOrder[0]
      const loadOrder = manager.loadPythonPlugin.mock.invocationCallOrder[0]
      expect(unloadOrder).toBeLessThan(loadOrder)
    })

    it("does not touch the python host for frontend plugins", async () => {
      const manager = fakeManager("frontend")
      getPluginManagerMock.mockImplementation(() => manager)

      const result = await reloader.reloadPlugin("js-plugin")
      expect(result.success).toBe(true)
      expect(manager.unloadPythonPlugin).not.toHaveBeenCalled()
      expect(manager.loadPythonPlugin).not.toHaveBeenCalled()
    })

    it("reports a failed reload when the python host cycle fails", async () => {
      const manager = fakeManager("hybrid")
      manager.loadPythonPlugin.mockRejectedValue(new Error("import boom"))
      getPluginManagerMock.mockImplementation(() => manager)

      const result = await reloader.reloadPlugin("py-plugin")
      expect(result.success).toBe(false)
      expect(result.error).toContain("import boom")
    })

    it("silently skips when the manager is not initialized", async () => {
      const result = await reloader.reloadPlugin("plugin-a")
      expect(result.success).toBe(true)
    })
  })

  describe("Reload Callbacks", () => {
    it("should add reload callback", () => {
      const callback = jest.fn()
      const unsubscribe = reloader.onReload(callback)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should remove reload callback", () => {
      const callback = jest.fn()
      const unsubscribe = reloader.onReload(callback)

      unsubscribe()
      // No error means success
    })

    it("should add error callback", () => {
      const callback = jest.fn()
      const unsubscribe = reloader.onError(callback)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should remove error callback", () => {
      const callback = jest.fn()
      const unsubscribe = reloader.onError(callback)

      unsubscribe()
      // No error means success
    })
  })

  describe("Reload History", () => {
    it("should get reload history", () => {
      const history = reloader.getReloadHistory()
      expect(Array.isArray(history)).toBe(true)
    })

    it("should get reload history for specific plugin", () => {
      const history = reloader.getReloadHistory("plugin-a")
      expect(Array.isArray(history)).toBe(true)
    })
  })

  describe("Plugin Loader", () => {
    it("should set plugin loader", () => {
      const loader = jest.fn().mockResolvedValue({})
      reloader.setPluginLoader(loader)
      // No error means success
    })

    it("should set plugin reloader", () => {
      const pluginReloader = jest.fn().mockResolvedValue(undefined)
      reloader.setPluginReloader(pluginReloader)
      // No error means success
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginHotReload()
    const instance1 = getPluginHotReload()
    const instance2 = getPluginHotReload()
    expect(instance1).toBe(instance2)
  })
})
