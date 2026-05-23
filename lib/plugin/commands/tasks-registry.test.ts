import {
  __resetTaskRegistryForTesting,
  cancelTask,
  clearDefaultTaskExecutor,
  executeTask,
  fetchTasks,
  getRunningTask,
  registerTaskProvider,
  setDefaultTaskExecutor,
  subscribeTaskRegistry,
  unregisterProvidersByPlugin,
  unregisterTaskProvider,
  type ResolvedTask,
  type TaskCompletionEvent,
  type TaskExecution,
} from "./tasks-registry"

function makeTask(id: string, type: string, name = id): ResolvedTask {
  return {
    id,
    name,
    source: type,
    definition: { type },
  }
}

function makeExecution(): TaskExecution & { resolve: (e: TaskCompletionEvent) => void } {
  let resolveFn: (event: TaskCompletionEvent) => void = () => {}
  const finished = new Promise<TaskCompletionEvent>((resolve) => {
    resolveFn = resolve
  })
  return {
    cancel: jest.fn(),
    finished,
    resolve: resolveFn,
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

  describe("execution", () => {
    it("dispatches to the provider's executor when it declared one", async () => {
      const exec = makeExecution()
      const executor = jest.fn(async () => exec)
      registerTaskProvider({
        type: "npm",
        pluginId: "p",
        provideTasks: async () => [],
        executor,
      })
      const result = await executeTask(makeTask("npm.build", "npm"))
      expect(executor).toHaveBeenCalledTimes(1)
      expect(result.finished).toBe(exec.finished)
    })

    it("falls back to the default executor when the provider had none", async () => {
      const exec = makeExecution()
      const defaultExec = jest.fn(async () => exec)
      setDefaultTaskExecutor(defaultExec)
      registerTaskProvider({
        type: "npm",
        pluginId: "p",
        provideTasks: async () => [],
      })
      await executeTask(makeTask("npm.x", "npm"))
      expect(defaultExec).toHaveBeenCalledTimes(1)
      clearDefaultTaskExecutor()
    })

    it("rejects when no executor is available at all", async () => {
      registerTaskProvider({
        type: "npm",
        pluginId: "p",
        provideTasks: async () => [],
      })
      await expect(executeTask(makeTask("npm.x", "npm"))).rejects.toThrow(/No executor available/i)
    })

    it("tracks running tasks and clears them on completion", async () => {
      const exec = makeExecution()
      const executor = jest.fn(async () => exec)
      registerTaskProvider({
        type: "npm",
        pluginId: "p",
        provideTasks: async () => [],
        executor,
      })
      const task = makeTask("npm.x", "npm")
      await executeTask(task)
      expect(getRunningTask(task.id)).toBe(exec)
      exec.resolve({
        taskId: task.id,
        exitCode: 0,
        signal: null,
        durationMs: 0,
      })
      await exec.finished
      // microtask flush
      await new Promise((r) => setTimeout(r, 0))
      expect(getRunningTask(task.id)).toBeUndefined()
    })

    it("cancel() returns true when the task is running, false otherwise", async () => {
      const exec = makeExecution()
      registerTaskProvider({
        type: "x",
        pluginId: "p",
        provideTasks: async () => [],
        executor: async () => exec,
      })
      const task = makeTask("x.t", "x")
      await executeTask(task)
      expect(cancelTask(task.id)).toBe(true)
      expect(exec.cancel).toHaveBeenCalled()
      expect(cancelTask("nope")).toBe(false)
    })
  })

  describe("subscriptions", () => {
    it("emits register / task-start / task-end events", async () => {
      const events: string[] = []
      const dispose = subscribeTaskRegistry((e) => {
        events.push(e.type)
      })
      const exec = makeExecution()
      registerTaskProvider({
        type: "x",
        pluginId: "p",
        provideTasks: async () => [],
        executor: async () => exec,
      })
      const task = makeTask("x.t", "x")
      await executeTask(task)
      exec.resolve({ taskId: task.id, exitCode: 0, signal: null, durationMs: 0 })
      await exec.finished
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toEqual(
        expect.arrayContaining(["register-provider", "task-start", "task-end"])
      )
      dispose()
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
