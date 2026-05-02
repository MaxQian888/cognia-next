/**
 * Tests for Plugin IPC
 */

import { PluginIPC, getPluginIPC, resetPluginIPC, createIPCAPI } from "./ipc"

describe("PluginIPC", () => {
  let ipc: PluginIPC

  beforeEach(() => {
    resetPluginIPC()
    ipc = new PluginIPC()
  })

  afterEach(() => {
    ipc.clear()
  })

  describe("Plugin Registration", () => {
    it("should register a plugin", () => {
      ipc.registerPlugin("plugin-a", [])
      expect(ipc.getExposedMethods("plugin-a")).toEqual([])
    })

    it("should unregister a plugin", () => {
      ipc.registerPlugin("plugin-a", [])
      ipc.unregisterPlugin("plugin-a")
      expect(ipc.getExposedMethods("plugin-a")).toEqual([])
    })
  })

  describe("Subscriptions", () => {
    it("should subscribe to a channel", () => {
      const handler = jest.fn()
      const unsubscribe = ipc.subscribe("plugin-a", "test-channel", handler)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should receive messages on subscribed channel", async () => {
      const handler = jest.fn()
      ipc.subscribe("plugin-b", "test-channel", handler)

      await ipc.send("plugin-a", "plugin-b", "test-channel", { data: "test" })

      expect(handler).toHaveBeenCalledWith({ data: "test" }, "plugin-a")
    })

    it("should unsubscribe correctly", async () => {
      const handler = jest.fn()
      const unsubscribe = ipc.subscribe("plugin-b", "test-channel", handler)

      unsubscribe()

      await ipc.send("plugin-a", "plugin-b", "test-channel", { data: "test" })

      expect(handler).not.toHaveBeenCalled()
    })

    it("should filter messages by sender", async () => {
      const handler = jest.fn()
      ipc.subscribe("plugin-b", "test-channel", handler, (senderId) => senderId === "plugin-a")

      await ipc.send("plugin-a", "plugin-b", "test-channel", { data: "from-a" })
      await ipc.send("plugin-c", "plugin-b", "test-channel", { data: "from-c" })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ data: "from-a" }, "plugin-a")
    })
  })

  describe("Broadcasting", () => {
    it("should broadcast to all subscribers except sender", () => {
      const handlerA = jest.fn()
      const handlerB = jest.fn()
      const handlerC = jest.fn()

      ipc.subscribe("plugin-a", "broadcast-channel", handlerA)
      ipc.subscribe("plugin-b", "broadcast-channel", handlerB)
      ipc.subscribe("plugin-c", "broadcast-channel", handlerC)

      ipc.broadcast("plugin-a", "broadcast-channel", { message: "hello" })

      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).toHaveBeenCalledWith({ message: "hello" }, "plugin-a")
      expect(handlerC).toHaveBeenCalledWith({ message: "hello" }, "plugin-a")
    })
  })

  describe("RPC (expose/call)", () => {
    it("should expose methods", () => {
      ipc.expose("plugin-a", {
        greet: (name: unknown) => `Hello, ${name}!`,
        add: (a: unknown, b: unknown) => (a as number) + (b as number),
      })

      const methods = ipc.getExposedMethods("plugin-a")
      expect(methods).toContain("greet")
      expect(methods).toContain("add")
    })

    it("should call exposed methods", async () => {
      ipc.expose("plugin-a", {
        greet: (name: unknown) => `Hello, ${name}!`,
      })

      const result = await ipc.call<string>("plugin-b", "plugin-a", "greet", "World")
      expect(result).toBe("Hello, World!")
    })

    it("should call async exposed methods", async () => {
      ipc.expose("plugin-a", {
        asyncGreet: async (name: unknown) => {
          return `Hello, ${name}!`
        },
      })

      const result = await ipc.call<string>("plugin-b", "plugin-a", "asyncGreet", "World")
      expect(result).toBe("Hello, World!")
    })

    it("should throw error for non-existent method", async () => {
      ipc.expose("plugin-a", {})

      await expect(ipc.call("plugin-b", "plugin-a", "nonExistent")).rejects.toThrow(
        "Method nonExistent not found"
      )
    })

    it("should throw error for non-existent plugin", async () => {
      await expect(ipc.call("plugin-b", "plugin-unknown", "method")).rejects.toThrow(
        "Plugin plugin-unknown has no exposed methods"
      )
    })

    it("should unexpose methods", () => {
      ipc.expose("plugin-a", {
        greet: () => "Hello",
        bye: () => "Goodbye",
      })

      ipc.unexpose("plugin-a", "greet")
      const methods = ipc.getExposedMethods("plugin-a")

      expect(methods).not.toContain("greet")
      expect(methods).toContain("bye")
    })
  })

  describe("Message History", () => {
    it("should record message history", async () => {
      await ipc.send("plugin-a", "plugin-b", "channel", { data: 1 })
      await ipc.send("plugin-a", "plugin-b", "channel", { data: 2 })

      const history = ipc.getMessageHistory()
      expect(history.length).toBe(2)
    })

    it("should filter history by channel", async () => {
      await ipc.send("plugin-a", "plugin-b", "channel-1", { data: 1 })
      await ipc.send("plugin-a", "plugin-b", "channel-2", { data: 2 })

      const history = ipc.getMessageHistory({ channel: "channel-1" })
      expect(history.length).toBe(1)
      expect(history[0].channel).toBe("channel-1")
    })

    it("should filter history by plugin", async () => {
      await ipc.send("plugin-a", "plugin-b", "channel", { data: 1 })
      await ipc.send("plugin-c", "plugin-d", "channel", { data: 2 })

      const history = ipc.getMessageHistory({ pluginId: "plugin-a" })
      expect(history.length).toBe(1)
    })
  })

  describe("Stats", () => {
    it("should return correct stats", () => {
      ipc.subscribe("plugin-a", "channel-1", () => {})
      ipc.subscribe("plugin-b", "channel-2", () => {})
      ipc.expose("plugin-a", { method1: () => {} })

      const stats = ipc.getStats()
      expect(stats.totalSubscriptions).toBe(2)
      expect(stats.totalExposedMethods).toBe(1)
    })
  })
})

describe("createIPCAPI", () => {
  beforeEach(() => {
    resetPluginIPC()
  })

  it("should create an IPC API for a plugin", () => {
    const api = createIPCAPI("my-plugin")

    expect(api.send).toBeDefined()
    expect(api.sendAndWait).toBeDefined()
    expect(api.broadcast).toBeDefined()
    expect(api.on).toBeDefined()
    expect(api.expose).toBeDefined()
    expect(api.call).toBeDefined()
    expect(api.getExposedMethods).toBeDefined()
  })

  it("should send messages using the API", async () => {
    const api = createIPCAPI("plugin-a")
    const ipc = getPluginIPC()
    const handler = jest.fn()

    ipc.subscribe("plugin-b", "test", handler)
    await api.send("plugin-b", "test", { hello: "world" })

    expect(handler).toHaveBeenCalledWith({ hello: "world" }, "plugin-a")
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginIPC()
    const instance1 = getPluginIPC()
    const instance2 = getPluginIPC()
    expect(instance1).toBe(instance2)
  })

  it("should reset the singleton", () => {
    const instance1 = getPluginIPC()
    resetPluginIPC()
    const instance2 = getPluginIPC()
    expect(instance1).not.toBe(instance2)
  })
})
