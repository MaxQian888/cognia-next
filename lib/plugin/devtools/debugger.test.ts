/**
 * Tests for Plugin Debugger
 */

import { PluginDebugger, getPluginDebugger, resetPluginDebugger } from "./debugger"

describe("PluginDebugger", () => {
  let debugger_: PluginDebugger

  beforeEach(() => {
    resetPluginDebugger()
    debugger_ = new PluginDebugger({ enabled: true })
  })

  afterEach(() => {
    debugger_.clear()
  })

  describe("Session Management", () => {
    it("should start a debug session", () => {
      const session = debugger_.startSession("plugin-a")

      expect(session.id).toBeTruthy()
      expect(session.pluginId).toBe("plugin-a")
      expect(session.status).toBe("active")
    })

    it("should stop a debug session", () => {
      debugger_.startSession("plugin-a")
      debugger_.stopSession("plugin-a")

      const session = debugger_.getSession("plugin-a")
      expect(session).toBeUndefined()
    })

    it("should get an existing session", () => {
      debugger_.startSession("plugin-a")

      const session = debugger_.getSession("plugin-a")
      expect(session).toBeDefined()
      expect(session?.pluginId).toBe("plugin-a")
    })

    it("tags structured runtime logs with the lifecycle generation", () => {
      debugger_.startSession("plugin-a", 7)
      debugger_.log("plugin-a", "info", "ready")
      debugger_.startSession("plugin-b", 8)
      debugger_.log("plugin-b", "info", "other")

      expect(debugger_.getLogs("plugin-a", { generation: 7 })).toEqual([
        expect.objectContaining({ pluginId: "plugin-a", generation: 7, message: "ready" }),
      ])
      expect(debugger_.getLogs("plugin-a", { generation: 8 })).toEqual([])
    })
  })

  describe("Logging", () => {
    it("should log messages", () => {
      debugger_.log("plugin-a", "info", "Test message", "arg1", "arg2")

      const logs = debugger_.getLogs("plugin-a")
      expect(logs.length).toBe(1)
      expect(logs[0].level).toBe("info")
      expect(logs[0].message).toBe("Test message")
      expect(logs[0].args).toEqual(["arg1", "arg2"])
    })

    it("should log different levels", () => {
      debugger_.log("plugin-a", "debug", "Debug")
      debugger_.log("plugin-a", "info", "Info")
      debugger_.log("plugin-a", "warn", "Warning")
      debugger_.log("plugin-a", "error", "Error")

      const logs = debugger_.getLogs("plugin-a")
      expect(logs.length).toBe(4)
    })

    it("should filter logs by level", () => {
      debugger_.log("plugin-a", "info", "Info")
      debugger_.log("plugin-a", "error", "Error")

      const errorLogs = debugger_.getLogs("plugin-a", { level: "error" })
      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0].level).toBe("error")
    })

    it("should limit logs", () => {
      for (let i = 0; i < 10; i++) {
        debugger_.log("plugin-a", "info", `Message ${i}`)
      }

      const logs = debugger_.getLogs("plugin-a", { limit: 5 })
      expect(logs.length).toBe(5)
    })

    it("should clear logs", () => {
      debugger_.log("plugin-a", "info", "Test")
      debugger_.clearLogs("plugin-a")

      expect(debugger_.getLogs("plugin-a").length).toBe(0)
    })

    it("should not log when disabled", () => {
      debugger_.setEnabled(false)
      debugger_.log("plugin-a", "info", "Test")

      expect(debugger_.getLogs("plugin-a").length).toBe(0)
    })
  })

  describe("Event Handlers", () => {
    it("should notify log handlers", () => {
      const handler = jest.fn()
      debugger_.onLog(handler)

      debugger_.log("plugin-a", "info", "Test")

      expect(handler).toHaveBeenCalled()
    })

    it("should unsubscribe log handlers", () => {
      const handler = jest.fn()
      const unsubscribe = debugger_.onLog(handler)

      unsubscribe()
      debugger_.log("plugin-a", "info", "Test")

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe("Debug Context", () => {
    it("should create a debug context", () => {
      const baseContext = {
        pluginId: "plugin-a",
        pluginPath: "/path/to/plugin",
        config: {},
        logger: {
          debug: jest.fn(),
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        },
        storage: {} as unknown,
        events: {} as unknown,
        ui: {} as unknown,
      } as unknown as Parameters<typeof debugger_.createDebugContext>[1]

      const debugContext = debugger_.createDebugContext("plugin-a", baseContext)

      debugContext.logger.info("Test message")

      expect(baseContext.logger.info).toHaveBeenCalledWith("Test message")
      expect(debugger_.getLogs("plugin-a").length).toBe(1)
    })
  })

  describe("Enable/Disable", () => {
    it("should toggle enabled state", () => {
      expect(debugger_.isEnabled()).toBe(true)

      debugger_.setEnabled(false)
      expect(debugger_.isEnabled()).toBe(false)

      debugger_.setEnabled(true)
      expect(debugger_.isEnabled()).toBe(true)
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginDebugger()
    const instance1 = getPluginDebugger()
    const instance2 = getPluginDebugger()
    expect(instance1).toBe(instance2)
  })
})
