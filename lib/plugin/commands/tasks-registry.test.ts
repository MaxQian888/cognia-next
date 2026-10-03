import {
  __resetTaskRegistryForTesting,
  fetchTasks,
  registerTaskProvider,
  subscribeTaskRegistry,
  unregisterProvidersByPlugin,
  unregisterTaskProvider,
  type ResolvedTask,
} from "./tasks-registry"

function makeTask(id: string, type: string, name = id): ResolvedTask {
  return {
    id,
    name,
    source: type,
    definition: { type },
  }
}

describe("task registry", () => {
  beforeEach(() => {
    __resetTaskRegistryForTesting()
  })

  describe("provider registration", () => {
    it("registers and lists tasks from a single provider", async () => {
      registerTaskProvider({
        type: "npm",
        pluginId: "vscode.npm",
        provideTasks: async () => [makeTask("npm.build", "npm")],
      })
      const tasks = await fetchTasks()
      expect(tasks.map((t) => t.id)).toEqual(["npm.build"])
    })

    it("filters by type", async () => {
      registerTaskProvider({
        type: "npm",
        pluginId: "p",
        provideTasks: async () => [makeTask("npm.x", "npm")],
      })
      registerTaskProvider({
        type: "cargo",
        pluginId: "p",
        provideTasks: async () => [makeTask("cargo.x", "cargo")],
      })
      const npm = await fetchTasks({ type: "npm" })
      expect(npm.map((t) => t.id)).toEqual(["npm.x"])
    })

    it("tolerates a provider that throws", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        registerTaskProvider({
          type: "broken",
          pluginId: "p1",
          provideTasks: async () => {
            throw new Error("kaboom")
          },
        })
        registerTaskProvider({
          type: "good",
          pluginId: "p1",
          provideTasks: async () => [makeTask("good.t", "good")],
        })
        const tasks = await fetchTasks()
        expect(tasks.map((t) => t.id)).toEqual(["good.t"])
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it("returns a dispose that unregisters", () => {
      const dispose = registerTaskProvider({
        type: "x",
        pluginId: "p",
        provideTasks: async () => [],
      })
      dispose()
      // After dispose, fetchTasks should yield nothing.
      return expect(fetchTasks()).resolves.toEqual([])
    })

    it("idempotent unregister", () => {
      registerTaskProvider({ type: "x", pluginId: "p", provideTasks: async () => [] })
      unregisterTaskProvider("x", "p")
      expect(() => unregisterTaskProvider("x", "p")).not.toThrow()
    })

    it("bulk-removes providers by plugin id", () => {
      registerTaskProvider({ type: "a", pluginId: "p1", provideTasks: async () => [] })
      registerTaskProvider({ type: "b", pluginId: "p1", provideTasks: async () => [] })
      registerTaskProvider({ type: "c", pluginId: "p2", provideTasks: async () => [] })
      const removed = unregisterProvidersByPlugin("p1")
      expect(removed).toBe(2)
    })
  })

  describe("subscriptions", () => {
    it("emits register and unregister events", async () => {
      const events: string[] = []
      const dispose = subscribeTaskRegistry((e) => {
        events.push(`${e.type}:${e.providerType}`)
      })
      const unregister = registerTaskProvider({
        type: "x",
        pluginId: "p",
        provideTasks: async () => [],
      })
      unregister()
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toEqual(["register-provider:x", "unregister-provider:x"])
      dispose()
    })

    it("passes a provider's wire tasks through as they are", async () => {
      const wire = {
        ...makeTask("acme.ext/npm/build", "npm", "build"),
        extensionId: "acme.ext",
        execution: { kind: "shell", commandLine: "npm run build", args: [] },
      }
      registerTaskProvider({ type: "npm", pluginId: "acme.ext", provideTasks: async () => [wire] })
      await expect(fetchTasks()).resolves.toEqual([wire])
    })

    it("survives a listener that throws", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const dispose = subscribeTaskRegistry(() => {
          throw new Error("listener boom")
        })
        registerTaskProvider({
          type: "x",
          pluginId: "p",
          provideTasks: async () => [],
        })
        await new Promise((r) => setTimeout(r, 0))
        expect(warn).toHaveBeenCalled()
        dispose()
      } finally {
        warn.mockRestore()
      }
    })
  })
})
