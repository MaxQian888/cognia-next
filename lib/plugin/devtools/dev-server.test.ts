/**
 * Tests for Plugin Dev Server
 */

import { PluginDevServer, getPluginDevServer, resetPluginDevServer } from "./dev-server"

// Mock Tauri APIs
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn().mockImplementation((cmd: string) => {
    switch (cmd) {
      case "plugin_dev_server_start":
        return Promise.resolve({ port: 9527, host: "localhost" })
      case "plugin_dev_server_stop":
        return Promise.resolve(null)
      case "plugin_build":
        return Promise.resolve({ success: true, outputPath: "/out" })
      case "plugin_list_dev_plugins":
        return Promise.resolve([])
      default:
        return Promise.resolve({})
    }
  }),
}))

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn().mockResolvedValue(() => {}),
  emit: jest.fn(),
}))

// Mock logger to avoid transport issues
jest.mock("../core/logger", () => ({
  loggers: {
    devServer: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  },
}))

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor() {
    setTimeout(() => this.onopen?.(), 0)
  }
  send = jest.fn()
  close = jest.fn()
}
global.WebSocket = MockWebSocket as unknown as typeof WebSocket

describe("PluginDevServer", () => {
  let server: PluginDevServer

  beforeEach(() => {
    resetPluginDevServer()
    server = new PluginDevServer()
  })

  afterEach(async () => {
    await server.stop()
  })

  describe("Server Lifecycle", () => {
    it("should start the server", async () => {
      await server.start()

      expect(server.isRunning()).toBe(true)
    })

    it("should stop the server", async () => {
      await server.start()
      await server.stop()

      expect(server.isRunning()).toBe(false)
    })

    it("should restart the server", async () => {
      await server.start()
      await server.restart()

      expect(server.isRunning()).toBe(true)
    })

    it("should not start if already running", async () => {
      await server.start()

      // Second start should be a no-op
      await server.start()

      expect(server.isRunning()).toBe(true)
    })
  })

  describe("Configuration", () => {
    it("should have default configuration", () => {
      const config = server.getConfig()

      expect(config.port).toBeDefined()
      expect(config.host).toBeDefined()
    })

    it("should accept custom configuration", () => {
      const customServer = new PluginDevServer({
        port: 4000,
        host: "127.0.0.1",
      })

      const config = customServer.getConfig()
      expect(config.port).toBe(4000)
      expect(config.host).toBe("127.0.0.1")
    })

    it("should update configuration", () => {
      server.setConfig({ port: 5000 })

      const config = server.getConfig()
      expect(config.port).toBe(5000)
    })
  })

  describe("Plugin Building", () => {
    it("should build a plugin", async () => {
      const result = await server.buildPlugin("plugin-a")

      expect(result.pluginId).toBe("plugin-a")
      expect(typeof result.success).toBe("boolean")
    })

    it("should build all plugins", async () => {
      const results = await server.buildAll()

      expect(Array.isArray(results)).toBe(true)
    })

    it("should have watchPlugin method", async () => {
      await server.watchPlugin("plugin-a", "/path/to/plugin")
      expect(server.isWatching("plugin-a")).toBe(true)
    })

    it("should have unwatchPlugin method", async () => {
      await server.watchPlugin("plugin-a", "/path/to/plugin")
      await server.unwatchPlugin("plugin-a")
      expect(server.isWatching("plugin-a")).toBe(false)
    })
  })

  describe("WebSocket Communication", () => {
    it("should get connected clients count", () => {
      const count = server.getConnectedClients()

      expect(typeof count).toBe("number")
    })

    it("should send message to clients", () => {
      server.sendMessage("test-event", { data: "test" })

      // No error means success
    })

    it("should broadcast to all clients", () => {
      server.broadcast("broadcast-event", { message: "hello" })

      // No error means success
    })
  })

  describe("Command Handling", () => {
    it("should register command handler", () => {
      const handler = jest.fn()
      server.onCommand("test-command", handler)

      // No error means success
    })

    it("should unregister command handler", () => {
      const handler = jest.fn()
      const unsubscribe = server.onCommand("test-command", handler)

      unsubscribe()

      // No error means success
    })

    it("should execute command", async () => {
      const handler = jest.fn().mockResolvedValue({ success: true })
      server.onCommand("test-command", handler)

      const result = await server.executeCommand("test-command", { arg: "value" })

      expect(result).toBeDefined()
    })
  })

  describe("Server Events", () => {
    it("should add start listener", () => {
      const listener = jest.fn()
      const unsubscribe = server.onStart(listener)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should add stop listener", () => {
      const listener = jest.fn()
      const unsubscribe = server.onStop(listener)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should add error listener", () => {
      const listener = jest.fn()
      const unsubscribe = server.onError(listener)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should add build listener", () => {
      const listener = jest.fn()
      const unsubscribe = server.onBuild(listener)

      expect(typeof unsubscribe).toBe("function")
    })
  })

  describe("Build History", () => {
    it("should get build history", () => {
      const history = server.getBuildHistory()

      expect(Array.isArray(history)).toBe(true)
    })

    it("should get build history for specific plugin", () => {
      const history = server.getBuildHistory("plugin-a")

      expect(Array.isArray(history)).toBe(true)
    })

    it("should clear build history", () => {
      server.clearBuildHistory()

      expect(server.getBuildHistory().length).toBe(0)
    })
  })

  describe("Server URL", () => {
    it("should get server URL", () => {
      const url = server.getUrl()

      expect(typeof url).toBe("string")
      expect(url).toContain("http")
    })

    it("should get WebSocket URL", () => {
      const wsUrl = server.getWebSocketUrl()

      expect(typeof wsUrl).toBe("string")
      expect(wsUrl).toContain("ws")
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginDevServer()
    const instance1 = getPluginDevServer()
    const instance2 = getPluginDevServer()
    expect(instance1).toBe(instance2)
  })
})
