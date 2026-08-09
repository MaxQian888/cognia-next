import { PluginDisposableScope, withPluginDisposableScope } from "./disposable-scope"

describe("PluginDisposableScope", () => {
  it("rolls back in reverse order, once", async () => {
    const calls: string[] = []
    const scope = new PluginDisposableScope("example")
    const first = scope.track(() => void calls.push("first"), "first")
    scope.track(() => void calls.push("second"), "second")
    await first()
    expect(await scope.dispose()).toEqual({ disposed: 1, failures: [] })
    expect(await scope.dispose()).toEqual({ disposed: 0, failures: [] })
    expect(calls).toEqual(["first", "second"])
  })

  it("aggregates failures and continues cleanup", async () => {
    const scope = new PluginDisposableScope("example")
    const survivor = jest.fn()
    scope.track(survivor, "survivor")
    scope.track(() => {
      throw new Error("broken")
    }, "broken")
    const report = await scope.dispose()
    expect(report.disposed).toBe(1)
    expect(report.failures).toEqual([{ label: "broken", error: expect.any(Error) }])
    expect(survivor).toHaveBeenCalled()
  })

  it("tracks synchronous and asynchronous registration results", async () => {
    const calls: string[] = []
    const scope = new PluginDisposableScope("example")
    const syncDispose = jest.fn(() => void calls.push("sync"))
    const asyncDispose = jest.fn(() => void calls.push("async"))
    const api = withPluginDisposableScope(scope, "events", {
      on: () => syncDispose,
      bus: { subscribe: async () => asyncDispose },
    })
    api.on()
    await api.bus.subscribe()
    await scope.dispose()
    expect(calls).toEqual(["async", "sync"])
  })

  it("does not treat ordinary returned callbacks as owned disposers", async () => {
    const scope = new PluginDisposableScope("example")
    const callback = jest.fn()
    const api = withPluginDisposableScope(scope, "commands", {
      getHandler: () => callback,
    })

    expect(api.getHandler()).toBe(callback)
    expect(await scope.dispose()).toEqual({ disposed: 0, failures: [] })
    expect(callback).not.toHaveBeenCalled()
  })

  it("preserves class instances nested in an API namespace", () => {
    class Registry {}
    const registry = new Registry()
    const api = withPluginDisposableScope(new PluginDisposableScope("example"), "ctx", {
      registry,
    })

    expect(api.registry).toBe(registry)
    expect(api.registry).toBeInstanceOf(Registry)
  })

  it("cleans late registrations after closure without rethrowing", async () => {
    const scope = new PluginDisposableScope("example")
    await scope.dispose()
    const dispose = jest.fn(() => {
      throw new Error("late failure")
    })

    expect(() => scope.track(dispose, "late")).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
