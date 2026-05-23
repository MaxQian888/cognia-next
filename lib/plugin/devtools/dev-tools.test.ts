/**
 * PluginDevTools Tests
 */

import {
  setDebugMode,
  isDebugEnabled,
  debugLog,
  getDebugLogs,
  clearDebugLogs,
  inspectPlugin,
  inspectAllPlugins,
  createMockPluginContext,
  validateManifestStrict,
} from "./dev-tools"
import { usePluginStore } from "@/stores/plugin-runtime"

// Mock dependencies
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
  },
}))

const mockGetState = usePluginStore.getState as jest.Mock

describe("PluginDevTools", () => {
  beforeEach(() => {
    setDebugMode(false)
    clearDebugLogs()
    jest.clearAllMocks()
  })

  describe("Debug Mode", () => {
    it("should enable and disable debug mode", () => {
      expect(isDebugEnabled()).toBe(false)

      setDebugMode(true)
      expect(isDebugEnabled()).toBe(true)

      setDebugMode(false)
      expect(isDebugEnabled()).toBe(false)
    })
  })

  describe("Debug Logging", () => {
    it("should log messages when debug mode is enabled", () => {
      setDebugMode(true)

      debugLog("test-plugin", "info", "general", "Test message")

      const logs = getDebugLogs()
      expect(logs).toHaveLength(1)
      expect(logs[0].pluginId).toBe("test-plugin")
      expect(logs[0].level).toBe("info")
      expect(logs[0].category).toBe("general")
      expect(logs[0].message).toBe("Test message")
    })

    it("should not log messages when debug mode is disabled", () => {
      setDebugMode(false)

      debugLog("test-plugin", "info", "general", "Test message")

      const logs = getDebugLogs()
      expect(logs).toHaveLength(0)
    })

    it("should filter logs by plugin id", () => {
      setDebugMode(true)

      debugLog("plugin-1", "info", "general", "Message 1")
      debugLog("plugin-2", "info", "general", "Message 2")
      debugLog("plugin-1", "warn", "lifecycle", "Message 3")

      const logs = getDebugLogs({ pluginId: "plugin-1" })
      expect(logs).toHaveLength(2)
      expect(logs.every((l) => l.pluginId === "plugin-1")).toBe(true)
    })

    it("should filter logs by level", () => {
      setDebugMode(true)

      debugLog("plugin-1", "info", "general", "Info message")
      debugLog("plugin-1", "warn", "general", "Warn message")
      debugLog("plugin-1", "error", "general", "Error message")

      const logs = getDebugLogs({ level: "error" })
      expect(logs).toHaveLength(1)
      expect(logs[0].level).toBe("error")
    })

    it("should filter logs by category", () => {
      setDebugMode(true)

      debugLog("plugin-1", "info", "lifecycle", "Lifecycle message")
      debugLog("plugin-1", "info", "hooks", "Hooks message")

      const logs = getDebugLogs({ category: "lifecycle" })
      expect(logs).toHaveLength(1)
      expect(logs[0].category).toBe("lifecycle")
    })

    it("should clear all logs", () => {
      setDebugMode(true)

      debugLog("plugin-1", "info", "general", "Message")
      expect(getDebugLogs()).toHaveLength(1)

      clearDebugLogs()
      expect(getDebugLogs()).toHaveLength(0)
    })
  })

  describe("Plugin Inspection", () => {
    it("should inspect a single plugin", () => {
      mockGetState.mockReturnValue({
        plugins: {
          "test-plugin": {
            manifest: {
              id: "test-plugin",
              name: "Test Plugin",
              version: "1.0.0",
            },
            status: "enabled",
            hooks: { onLoad: jest.fn() },
            components: [{ type: "sidebar" }],
            tools: [{ name: "test-tool" }],
          },
        },
      })

      const info = inspectPlugin("test-plugin")

      expect(info).toBeDefined()
      expect(info?.id).toBe("test-plugin")
      expect(info?.status).toBe("enabled")
      expect(info?.registeredHooks).toContain("onLoad")
      expect(info?.registeredComponents).toContain("sidebar")
      expect(info?.registeredTools).toContain("test-tool")
    })

    it("should return null for non-existent plugin", () => {
      mockGetState.mockReturnValue({ plugins: {} })

      const info = inspectPlugin("non-existent")
      expect(info).toBeNull()
    })

    it("should inspect all plugins", () => {
      mockGetState.mockReturnValue({
        plugins: {
          "plugin-1": {
            manifest: { id: "plugin-1", name: "Plugin 1", version: "1.0.0" },
            status: "enabled",
          },
          "plugin-2": {
            manifest: { id: "plugin-2", name: "Plugin 2", version: "2.0.0" },
            status: "disabled",
          },
        },
      })

      const allInfo = inspectAllPlugins()

      expect(allInfo).toHaveLength(2)
      expect(allInfo.some((p) => p.id === "plugin-1")).toBe(true)
      expect(allInfo.some((p) => p.id === "plugin-2")).toBe(true)
    })
  })

  describe("Mock Plugin Context", () => {
    it("should create a mock context with basic properties", () => {
      const context = createMockPluginContext("test-plugin")

      expect(context.pluginId).toBe("test-plugin")
      expect(context.pluginPath).toBe("/mock/plugins/test-plugin")
      expect(context.config).toEqual({})
    })

    it("should create a mock context with custom config", () => {
      const context = createMockPluginContext("test-plugin", {
        config: { setting1: "value1" },
      })

      expect(context.config).toEqual({ setting1: "value1" })
    })

    it("should provide working logger", () => {
      const context = createMockPluginContext("test-plugin")

      expect(() => context.logger?.debug("test")).not.toThrow()
      expect(() => context.logger?.info("test")).not.toThrow()
      expect(() => context.logger?.warn("test")).not.toThrow()
      expect(() => context.logger?.error("test")).not.toThrow()
    })

    it("should provide working storage", async () => {
      const context = createMockPluginContext("test-plugin")

      await context.storage?.set("key", "value")
      const value = await context.storage?.get<string>("key")
      expect(value).toBe("value")

      await context.storage?.delete("key")
      const deleted = await context.storage?.get<string>("key")
      expect(deleted).toBeUndefined()
    })

    it("should simulate errors when option is set", async () => {
      const context = createMockPluginContext("test-plugin", {
        simulateErrors: true,
      })

      await expect(context.storage?.get("key")).rejects.toThrow("Storage error")
    })
  })

  describe("Manifest Validation", () => {
    it("should validate a correct manifest", () => {
      const manifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        description: "A test plugin",
        author: { name: "Test Author" },
        main: "index.js",
        type: "frontend" as const,
        capabilities: [],
      }

      const result = validateManifestStrict(manifest)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("should detect missing required fields", () => {
      const manifest = {
        id: "test-plugin",
      }

      const result = validateManifestStrict(manifest as never)

      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it("should detect invalid version format", () => {
      const manifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "invalid-version",
        description: "Test",
        main: "index.js",
        type: "frontend" as const,
        capabilities: [],
      }

      const result = validateManifestStrict(manifest)

      expect(result.warnings.some((w) => w.includes("semver"))).toBe(true)
    })

    it("should warn about empty permissions", () => {
      const manifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        description: "Test",
        main: "index.js",
        type: "frontend" as const,
        capabilities: [],
        permissions: [],
      }

      const result = validateManifestStrict(manifest)

      expect(result.warnings.some((w) => w.includes("permissions"))).toBe(true)
    })
  })
})
