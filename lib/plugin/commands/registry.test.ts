import {
  CommandNotFoundError,
  __resetCommandRegistryForTesting,
  executeCommand,
  getCommand,
  getCommands,
  listCommandsByPlugin,
  registerCommand,
  subscribeCommandRegistry,
  unregisterCommand,
  unregisterCommandsByPlugin,
} from "./registry"

describe("command registry", () => {
  beforeEach(() => {
    __resetCommandRegistryForTesting()
  })

  describe("registration", () => {
    it("registers a command and returns a dispose function", () => {
      const dispose = registerCommand({
        id: "hello.world",
        pluginId: null,
        handler: () => "hi",
      })
      expect(getCommand("hello.world")?.id).toBe("hello.world")
      dispose()
      expect(getCommand("hello.world")).toBeUndefined()
    })

    it("overrides on duplicate id but warns", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        registerCommand({ id: "x", pluginId: "a", handler: () => 1 })
        registerCommand({ id: "x", pluginId: "b", handler: () => 2 })
        expect(getCommand("x")?.pluginId).toBe("b")
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already registered/))
      } finally {
        warn.mockRestore()
      }
    })

    it("is idempotent on unregister", () => {
      registerCommand({ id: "x", pluginId: null, handler: () => 1 })
      unregisterCommand("x")
      // Second unregister should not throw.
      expect(() => unregisterCommand("x")).not.toThrow()
    })
  })

  describe("execution", () => {
    it("executes the handler and returns its result", async () => {
      registerCommand({ id: "math.add", pluginId: null, handler: (a, b) => Number(a) + Number(b) })
      const result = await executeCommand<number>("math.add", 2, 3)
      expect(result).toBe(5)
    })

    it("awaits async handlers", async () => {
      registerCommand({
        id: "async.echo",
        pluginId: null,
        handler: async (s) => `${String(s)}!`,
      })
      const result = await executeCommand<string>("async.echo", "hi")
      expect(result).toBe("hi!")
    })

    it("throws CommandNotFoundError for unknown ids", async () => {
      await expect(executeCommand("does.not.exist")).rejects.toBeInstanceOf(CommandNotFoundError)
    })
  })

  describe("listing", () => {
    it("returns sorted command ids", () => {
      registerCommand({ id: "b", pluginId: null, handler: () => 1 })
      registerCommand({ id: "a", pluginId: null, handler: () => 1 })
      expect(getCommands()).toEqual(["a", "b"])
    })

    it("filters internal commands when requested", () => {
      registerCommand({ id: "_internal", pluginId: null, handler: () => 1 })
      registerCommand({ id: "public", pluginId: null, handler: () => 1 })
      expect(getCommands(true)).toEqual(["public"])
      expect(getCommands(false)).toEqual(["_internal", "public"])
    })

    it("lists commands by plugin id", () => {
      registerCommand({ id: "p1.a", pluginId: "p1", handler: () => 1 })
      registerCommand({ id: "p1.b", pluginId: "p1", handler: () => 1 })
      registerCommand({ id: "p2.a", pluginId: "p2", handler: () => 1 })
      expect(
        listCommandsByPlugin("p1")
          .map((c) => c.id)
          .sort()
      ).toEqual(["p1.a", "p1.b"])
    })
  })

  describe("bulk unregister", () => {
    it("removes every command registered by a plugin", () => {
      registerCommand({ id: "p1.a", pluginId: "p1", handler: () => 1 })
      registerCommand({ id: "p1.b", pluginId: "p1", handler: () => 1 })
      registerCommand({ id: "p2.a", pluginId: "p2", handler: () => 1 })
      const removed = unregisterCommandsByPlugin("p1")
      expect(removed).toBe(2)
      expect(getCommands()).toEqual(["p2.a"])
    })

    it("returns zero when plugin had nothing registered", () => {
      expect(unregisterCommandsByPlugin("nope")).toBe(0)
    })
  })

  describe("subscriptions", () => {
    it("notifies listeners about register / unregister events", async () => {
      const events: string[] = []
      const dispose = subscribeCommandRegistry((e) => {
        events.push(`${e.type}:${e.id}`)
      })
      registerCommand({ id: "a", pluginId: null, handler: () => 1 })
      unregisterCommand("a")
      await flushMicrotasks()
      expect(events).toEqual(expect.arrayContaining(["register:a", "unregister:a"]))
      dispose()
    })

    it("emits a synthetic register for every existing entry on subscribe", async () => {
      registerCommand({ id: "preexisting", pluginId: null, handler: () => 1 })
      const events: string[] = []
      const dispose = subscribeCommandRegistry((e) => {
        events.push(`${e.type}:${e.id}`)
      })
      await flushMicrotasks()
      expect(events).toContain("register:preexisting")
      dispose()
    })

    it("survives a listener that throws", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const dispose = subscribeCommandRegistry(() => {
          throw new Error("listener boom")
        })
        registerCommand({ id: "a", pluginId: null, handler: () => 1 })
        await flushMicrotasks()
        expect(warn).toHaveBeenCalled()
        dispose()
      } finally {
        warn.mockRestore()
      }
    })
  })
})

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}
