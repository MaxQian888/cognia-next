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
    expect(scope.getDiagnostics()).toMatchObject({ active: 0, pending: 0, failed: 1 })
  })

  it("retains failed cleanup entries so a later recovery can retry them", async () => {
    const scope = new PluginDisposableScope("example", 7)
    const dispose = jest
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined)
    scope.track(dispose, "worker")

    expect(await scope.dispose()).toEqual({
      disposed: 0,
      failures: [{ label: "worker", error: expect.any(Error) }],
    })
    expect(scope.hasUnresolvedResources()).toBe(true)

    expect(await scope.dispose()).toEqual({ disposed: 1, failures: [] })
    expect(scope.hasUnresolvedResources()).toBe(false)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it("tracks synchronous and asynchronous registration results", async () => {
    const calls: string[] = []
    const scope = new PluginDisposableScope("example")
    const syncDispose = jest.fn(() => void calls.push("sync"))
    const asyncDispose = jest.fn(() => void calls.push("async"))
    const api = withPluginDisposableScope(
      scope,
      "events",
      {
        on: () => syncDispose,
        bus: { subscribe: async () => asyncDispose },
      },
      {
        "events.on": { kind: "returned-disposer" },
        "events.bus.subscribe": { kind: "returned-disposer" },
      }
    )
    api.on()
    await api.bus.subscribe()
    await scope.dispose()
    expect(calls).toEqual(["async", "sync"])
  })

  it("does not re-invoke a disposer the plugin already called", async () => {
    const scope = new PluginDisposableScope("example")
    const off = jest.fn()
    const api = withPluginDisposableScope(
      scope,
      "ctx",
      { events: { on: () => off } },
      { "ctx.events.on": { kind: "returned-disposer" } }
    )

    // The plugin tears its own subscription down inside `deactivate()`.
    await api.events.on()()
    expect(off).toHaveBeenCalledTimes(1)

    expect(await scope.dispose()).toEqual({ disposed: 0, failures: [] })
    expect(off).toHaveBeenCalledTimes(1)
    expect(scope.hasUnresolvedResources()).toBe(false)
  })

  it("does not re-invoke an async disposer the plugin already called", async () => {
    const scope = new PluginDisposableScope("example")
    const off = jest.fn()
    const api = withPluginDisposableScope(
      scope,
      "ctx",
      { events: { on: async () => off } },
      { "ctx.events.on": { kind: "returned-disposer" } }
    )

    await (
      await api.events.on()
    )()
    expect(off).toHaveBeenCalledTimes(1)

    expect(await scope.dispose()).toEqual({ disposed: 0, failures: [] })
    expect(off).toHaveBeenCalledTimes(1)
  })

  it("does not re-invoke a returned handle the plugin already disposed", async () => {
    const scope = new PluginDisposableScope("example")
    const dispose = jest.fn()
    const api = withPluginDisposableScope(
      scope,
      "ctx",
      { webview: { create: () => ({ id: "demo", dispose }) } },
      { "ctx.webview.create": { kind: "returned-handle", disposeMethod: "dispose" } }
    )

    await api.webview.create().dispose()
    expect(dispose).toHaveBeenCalledTimes(1)

    await scope.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("disposes an async registration that resolves while the sweep is running", async () => {
    let resolveRegistration!: (dispose: () => void) => void
    const registration = new Promise<() => void>((resolve) => {
      resolveRegistration = resolve
    })
    const late = jest.fn()
    // A slow disposer holds the sweep open so the registration lands mid-sweep,
    // i.e. after the pending grace elapsed but before the scope is closed.
    let releaseSlow!: () => void
    const scope = new PluginDisposableScope("example", 8, { pendingGraceMs: 5 })
    scope.track(
      () =>
        new Promise<void>((resolve) => {
          releaseSlow = resolve
        }),
      "slow"
    )
    const api = withPluginDisposableScope(
      scope,
      "ctx",
      { events: { on: () => registration } },
      { "ctx.events.on": { kind: "returned-disposer" } }
    )
    void api.events.on()

    const cleanup = scope.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    resolveRegistration(late)
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseSlow()
    await cleanup

    expect(late).toHaveBeenCalledTimes(1)
  })

  it("tracks an explicitly declared returned handle", async () => {
    const scope = new PluginDisposableScope("example", 3)
    const dispose = jest.fn()
    const api = withPluginDisposableScope(
      scope,
      "ctx",
      {
        webview: {
          create: () => ({ id: "demo", dispose }),
        },
      },
      {
        "ctx.webview.create": { kind: "returned-handle", disposeMethod: "dispose" },
      }
    )

    api.webview.create()
    await scope.dispose()

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("waits for an in-flight async registration before declaring the generation clean", async () => {
    let resolveRegistration!: (dispose: () => void) => void
    const registration = new Promise<() => void>((resolve) => {
      resolveRegistration = resolve
    })
    const dispose = jest.fn()
    const scope = new PluginDisposableScope("example", 4)
    const api = withPluginDisposableScope(
      scope,
      "ctx",
      { events: { on: () => registration } },
      { "ctx.events.on": { kind: "returned-disposer" } }
    )

    void api.events.on()
    const cleanup = scope.dispose()
    resolveRegistration(dispose)

    await expect(cleanup).resolves.toEqual({ disposed: 1, failures: [] })
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("bounds pending registration grace and marks the generation unresolved", async () => {
    const scope = new PluginDisposableScope("example", 5, { pendingGraceMs: 5 })
    const api = withPluginDisposableScope(
      scope,
      "ctx",
      { events: { on: () => new Promise<() => void>(() => undefined) } },
      { "ctx.events.on": { kind: "returned-disposer" } }
    )

    void api.events.on()

    await expect(scope.dispose()).resolves.toMatchObject({
      failures: [{ label: "pending-registration", error: expect.any(Error) }],
    })
    expect(scope.hasUnresolvedResources()).toBe(true)
  })

  it("times out a hanging disposer without blocking later cleanup", async () => {
    const scope = new PluginDisposableScope("example", 6, { disposeTimeoutMs: 5 })
    const later = jest.fn()
    scope.track(later, "later")
    scope.track(() => new Promise<void>(() => undefined), "hung")

    const report = await scope.dispose()

    expect(report).toMatchObject({
      disposed: 1,
      failures: [{ label: "hung", error: expect.any(Error) }],
    })
    expect(later).toHaveBeenCalledTimes(1)
    expect(scope.hasUnresolvedResources()).toBe(true)
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

  it("does not infer resource ownership from a method name", async () => {
    const scope = new PluginDisposableScope("example")
    const dispose = jest.fn()
    const api = withPluginDisposableScope(scope, "ctx", {
      registerLegacyThing: () => dispose,
    })

    expect(api.registerLegacyThing()).toBe(dispose)
    await scope.dispose()

    expect(dispose).not.toHaveBeenCalled()
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
    expect(scope.hasUnresolvedResources()).toBe(true)
  })

  it("disposes child scopes before parent resources in reverse child order", async () => {
    const calls: string[] = []
    const parent = new PluginDisposableScope("example", 9)
    parent.track(() => void calls.push("parent"), "parent")
    const first = parent.createChildScope("optional:first")
    first.track(() => void calls.push("first"), "first")
    const second = parent.createChildScope("optional:second")
    second.track(() => void calls.push("second"), "second")

    await parent.dispose()

    expect(calls).toEqual(["second", "first", "parent"])
  })

  it("immediately disposes a child created after parent teardown starts", async () => {
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const parent = new PluginDisposableScope("example", 9)
    const first = parent.createChildScope("first")
    first.track(() => firstCanFinish, "blocking-resource")

    const parentDisposal = parent.dispose()
    await Promise.resolve()
    const lateDispose = jest.fn()
    const late = parent.createChildScope("late")
    late.track(lateDispose, "late-resource")
    releaseFirst()
    await parentDisposal
    await Promise.resolve()

    expect(lateDispose).toHaveBeenCalledTimes(1)
    expect(late.hasUnresolvedResources()).toBe(false)
  })

  it("requires an exact scope token for caller-owned resources", async () => {
    const scope = new PluginDisposableScope("example", 10, {
      realmId: "project:alpha",
      scopeId: "feature",
    })
    const dispose = jest.fn()

    expect(() =>
      scope.trackFor(
        { realmId: "project:beta", pluginId: "example", generation: 10, scopeId: "feature" },
        dispose,
        "worker"
      )
    ).toThrow("scope token")
    scope.trackFor(scope.token, dispose, "worker")
    await scope.dispose()

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("rejects realms outside global, project, and session", () => {
    expect(
      () =>
        new PluginDisposableScope("example", 1, {
          realmId: "workspace:legacy" as never,
        })
    ).toThrow("Unsupported plugin realm")
  })
})
