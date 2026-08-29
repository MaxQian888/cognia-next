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

    it("should pause a session", () => {
      debugger_.startSession("plugin-a")
      debugger_.pauseSession("plugin-a")

      const session = debugger_.getSession("plugin-a")
      expect(session?.status).toBe("paused")
    })

    it("should resume a session", () => {
      debugger_.startSession("plugin-a")
      debugger_.pauseSession("plugin-a")
      debugger_.resumeSession("plugin-a")

      const session = debugger_.getSession("plugin-a")
      expect(session?.status).toBe("active")
    })
  })

  describe("Breakpoints", () => {
    beforeEach(() => {
      debugger_.startSession("plugin-a")
    })

    it("should add a breakpoint", () => {
      const bp = debugger_.addBreakpoint("plugin-a", "file.ts:10")

      expect(bp.id).toBeTruthy()
      expect(bp.location).toBe("file.ts:10")
      expect(bp.enabled).toBe(true)
    })

    it("should add a conditional breakpoint", () => {
      const bp = debugger_.addBreakpoint("plugin-a", "file.ts:10", "x > 5")

      expect(bp.condition).toBe("x > 5")
    })

    it("should remove a breakpoint", () => {
      const bp = debugger_.addBreakpoint("plugin-a", "file.ts:10")
      debugger_.removeBreakpoint("plugin-a", bp.id)

      const session = debugger_.getSession("plugin-a")
      expect(session?.breakpoints.find((b) => b.id === bp.id)).toBeUndefined()
    })

    it("should toggle a breakpoint", () => {
      const bp = debugger_.addBreakpoint("plugin-a", "file.ts:10")

      debugger_.toggleBreakpoint("plugin-a", bp.id)
      let session = debugger_.getSession("plugin-a")
      expect(session?.breakpoints.find((b) => b.id === bp.id)?.enabled).toBe(false)

      debugger_.toggleBreakpoint("plugin-a", bp.id)
      session = debugger_.getSession("plugin-a")
      expect(session?.breakpoints.find((b) => b.id === bp.id)?.enabled).toBe(true)
    })

    it("should clear all breakpoints", () => {
      debugger_.addBreakpoint("plugin-a", "file.ts:10")
      debugger_.addBreakpoint("plugin-a", "file.ts:20")
      debugger_.clearBreakpoints("plugin-a")

      const session = debugger_.getSession("plugin-a")
      expect(session?.breakpoints.length).toBe(0)
    })
  })

  describe("Call Stack", () => {
    beforeEach(() => {
      debugger_.startSession("plugin-a")
    })

    it("should push a frame", () => {
      const frame = debugger_.pushFrame("plugin-a", "myFunction", "file.ts:10", { arg1: "value" })

      expect(frame.functionName).toBe("myFunction")
      expect(frame.location).toBe("file.ts:10")
      expect(frame.arguments).toEqual({ arg1: "value" })
    })

    it("should pop a frame", () => {
      debugger_.pushFrame("plugin-a", "function1", "file.ts:10")
      debugger_.pushFrame("plugin-a", "function2", "file.ts:20")

      const popped = debugger_.popFrame("plugin-a")

      expect(popped?.functionName).toBe("function2")
    })

    it("should get call stack", () => {
      debugger_.pushFrame("plugin-a", "function1", "file.ts:10")
      debugger_.pushFrame("plugin-a", "function2", "file.ts:20")

      const stack = debugger_.getCallStack("plugin-a")

      expect(stack.length).toBe(2)
      expect(stack[0].functionName).toBe("function1")
      expect(stack[1].functionName).toBe("function2")
    })

    it("should not push frames for inactive sessions", () => {
      debugger_.pauseSession("plugin-a")

      const frame = debugger_.pushFrame("plugin-a", "function", "file.ts:10")

      expect(frame.id).toBe("")
    })
  })

  describe("Watch Expressions", () => {
    beforeEach(() => {
      debugger_.startSession("plugin-a")
    })

    it("should add a watch expression", () => {
      const watch = debugger_.addWatch("plugin-a", "myVar")

      expect(watch.id).toBeTruthy()
      expect(watch.expression).toBe("myVar")
    })

    it("should remove a watch expression", () => {
      const watch = debugger_.addWatch("plugin-a", "myVar")
      debugger_.removeWatch("plugin-a", watch.id)

      const session = debugger_.getSession("plugin-a")
      expect(session?.watchExpressions.find((w) => w.id === watch.id)).toBeUndefined()
    })

    it("should evaluate a watch expression", () => {
      const watch = debugger_.addWatch("plugin-a", "x + y")
      debugger_.evaluateWatch("plugin-a", watch.id, { x: 5, y: 10 })

      const session = debugger_.getSession("plugin-a")
      const evaluated = session?.watchExpressions.find((w) => w.id === watch.id)
      expect(evaluated?.value).toBe(15)
    })

    it("should handle evaluation errors", () => {
      const watch = debugger_.addWatch("plugin-a", "invalid.syntax()")
      debugger_.evaluateWatch("plugin-a", watch.id, {})

      const session = debugger_.getSession("plugin-a")
      const evaluated = session?.watchExpressions.find((w) => w.id === watch.id)
      expect(evaluated?.error).toBeTruthy()
    })

    it("should evaluate all watches", () => {
      debugger_.addWatch("plugin-a", "a")
      debugger_.addWatch("plugin-a", "b")

      debugger_.evaluateAllWatches("plugin-a", { a: 1, b: 2 })

      const session = debugger_.getSession("plugin-a")
      expect(session?.watchExpressions[0].value).toBe(1)
      expect(session?.watchExpressions[1].value).toBe(2)
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
