import type { Plugin } from "@/types/plugin"
import type { FullPluginContext } from "../core/context"
import { PluginDisposableScope } from "../core/disposable-scope"
import { evaluatePluginBundle } from "../core/evaluate-plugin-bundle"
import { assertLibraryAccess, authorizeLibraryAccess } from "./access"
import { PluginLibraryModules } from "./modules"
import { loggers } from "../core/logger"

jest.mock("../core/logger", () => ({ loggers: { manager: { info: jest.fn() } } }))

jest.mock("./access", () => ({ assertLibraryAccess: jest.fn(), authorizeLibraryAccess: jest.fn() }))

describe("consumer-owned library modules", () => {
  let scopes: Map<string, PluginDisposableScope>
  let load: jest.Mock
  let modules: PluginLibraryModules
  let provider: Plugin
  let check: jest.Mock
  const hostCall = jest.fn(() => "host")
  const context = { network: { fetch: hostCall } } as unknown as FullPluginContext

  beforeEach(() => {
    jest.clearAllMocks()
    scopes = new Map(
      ["a", "b", "lib"].map((id) => [id, new PluginDisposableScope(id, 1, { pendingGraceMs: 1 })])
    )
    provider = {
      manifest: {
        id: "lib",
        name: "Library fixture",
        description: "Library module test provider",
        capabilities: [],
        type: "frontend",
        version: "1.0.0",
        library: {
          modules: {
            utils: {
              entry: "utils.cjs",
              description: "Utils",
              risk: "read",
              requiredPermissions: [],
            },
          },
        },
      },
      status: "enabled",
      source: "local",
      path: "/plugins/lib",
      config: {},
    }
    jest.mocked(assertLibraryAccess).mockImplementation((callerId) => ({
      caller: {
        manifest: {
          id: callerId,
          name: "Consumer fixture",
          description: "Module consumer",
          version: "1.0.0",
          capabilities: [],
          type: "frontend",
          dependencies: { lib: "^1.0.0" },
        },
        status: "enabled",
        source: "local",
        path: `/plugins/${callerId}`,
        config: {},
      },
      provider,
    }))
    check = jest.fn()
    jest.mocked(authorizeLibraryAccess).mockResolvedValue(check)
    load = jest.fn(async () =>
      evaluatePluginBundle(
        `let count = 0; module.exports.default = ctx => ({exports: {next: () => ++count, host: () => ctx.network.fetch(), Counter: class Counter { value = ++count }}})`,
        "utils.cjs"
      )
    )
    modules = new PluginLibraryModules({
      getPluginDisposableScope: (id) => scopes.get(id)!,
      peekPluginDisposableScope: (id) => scopes.get(id),
      importLibraryEntry: load,
    })
  })

  it("audits each import result with safe metadata including cached imports and failures", async () => {
    const secret = { privateValue: "never-log-factory-output" }
    load.mockResolvedValue({ default: () => ({ exports: secret }) })
    await modules.importModule("a", "lib", "utils", context)
    await modules.importModule("a", "lib", "utils", context)
    load.mockRejectedValue(new Error("never-log-error-payload"))
    await expect(modules.importModule("b", "lib", "utils", context)).rejects.toThrow(
      "never-log-error-payload"
    )
    const entries = jest.mocked(loggers.manager.info).mock.calls
    expect(entries).toHaveLength(3)
    for (const [index, [message, metadata]] of entries.entries()) {
      expect(message).toBe("Library module import")
      expect(metadata).toEqual({
        callerId: index === 2 ? "b" : "a",
        providerId: "lib",
        module: "utils",
        version: "1.0.0",
        risk: "read",
        outcome: index === 2 ? "failure" : "success",
        durationMs: expect.any(Number),
        timestamp: expect.any(Number),
      })
    }
    expect(JSON.stringify(entries)).not.toContain("never-log")
  })

  it("audits rejected dependencies without exposing their error payload", async () => {
    jest.mocked(assertLibraryAccess).mockImplementationOnce(() => {
      throw new Error("secret-denial")
    })
    await expect(modules.importModule("a", "lib", "utils", context)).rejects.toThrow(
      "secret-denial"
    )
    expect(loggers.manager.info).toHaveBeenCalledWith("Library module import", {
      callerId: "a",
      providerId: "lib",
      module: "utils",
      version: null,
      risk: null,
      outcome: "failure",
      durationMs: expect.any(Number),
      timestamp: expect.any(Number),
    })
  })

  it("shares concurrent initialization only within a consumer and preserves classes", async () => {
    type Exports = { next: () => number; Counter: new () => { value: number } }
    const [a, same, b] = await Promise.all([
      modules.importModule<Exports>("a", "lib", "utils", context),
      modules.importModule<Exports>("a", "lib", "utils", context),
      modules.importModule<Exports>("b", "lib", "utils", context),
    ])
    expect(a).toBe(same)
    expect(a.next()).toBe(1)
    expect(new a.Counter().value).toBe(2)
    expect(b.next()).toBe(1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("fences retained host calls after teardown and after reactivation of the same ID", async () => {
    const exports = await modules.importModule<{ host: () => string }>("a", "lib", "utils", context)
    expect(exports.host()).toBe("host")
    await scopes.get("a")!.dispose()
    scopes.set("a", new PluginDisposableScope("a", 2))
    expect(() => exports.host()).toThrow("activation has ended")
    const fresh = await modules.importModule<{ host: () => string }>("a", "lib", "utils", context)
    expect(fresh.host()).toBe("host")
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("rechecks grants on retained host calls and disposes registered resources", async () => {
    const dispose = jest.fn()
    load.mockResolvedValue({
      default: (ctx: FullPluginContext) => {
        ctx.lifecycle.onDispose(dispose)
        return { exports: { host: () => ctx.network.fetch("https://example.test") } }
      },
    })
    const exports = await modules.importModule<{ host: () => unknown }>(
      "a",
      "lib",
      "utils",
      context
    )
    check.mockImplementation(() => {
      throw new Error("permission revoked")
    })
    expect(() => exports.host()).toThrow("permission revoked")
    await scopes.get("a")!.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("disposes a factory result that arrives after consumer teardown", async () => {
    let finish!: (value: unknown) => void
    const dispose = jest.fn()
    load.mockResolvedValue({
      default: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const pending = modules.importModule("a", "lib", "utils", context)
    const rejection = expect(pending).rejects.toThrow("activation has ended")
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await scopes.get("a")!.dispose()
    finish({ exports: {}, dispose })
    await rejection
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("preserves JSON arrays, dates, native signals, live config and independently bound handles", async () => {
    class Handle {
      constructor(readonly id: number) {}
      read() {
        return this.id
      }
    }
    let configuration = { enabled: false }
    const signal = new AbortController().signal
    const host = {
      get config() {
        return configuration
      },
      data: {
        read: async () =>
          Object.freeze({
            rows: Object.freeze([{ id: 1 }]),
            date: new Date("2026-10-13T00:00:00Z"),
          }),
        handle: (id: number) => new Handle(id),
        signal: () => signal,
      },
    } as unknown as FullPluginContext
    let ctx!: typeof host & {
      data: {
        read(): Promise<{ rows: { id: number }[]; date: Date }>
        handle(id: number): Handle
        signal(): AbortSignal
      }
    }
    load.mockResolvedValue({
      default: (value: typeof ctx) => {
        ctx = value
        return { exports: {} }
      },
    })
    await modules.importModule("a", "lib", "utils", host)
    const data = await ctx.data.read()
    expect(Array.isArray(data.rows)).toBe(true)
    expect(data.rows.map((row) => row.id)).toEqual([1])
    expect(Object.keys(data.rows)).toEqual(["0"])
    expect(JSON.parse(JSON.stringify(data))).toEqual({
      rows: [{ id: 1 }],
      date: "2026-10-13T00:00:00.000Z",
    })
    expect(data.date).toBeInstanceOf(Date)
    expect(data.date.getUTCFullYear()).toBe(2026)
    const first = ctx.data.handle(1)
    const second = ctx.data.handle(2)
    expect(first).toBeInstanceOf(Handle)
    expect(first.read()).toBe(1)
    expect(second.read()).toBe(2)
    expect(Reflect.ownKeys(ctx.data.read)).toEqual(expect.arrayContaining(["length", "name"]))
    expect(ctx.data.signal()).toBe(signal)
    const lifetime = ctx.lifecycle.signal
    expect(lifetime).toBeInstanceOf(AbortSignal)
    const onAbort = jest.fn()
    lifetime.addEventListener("abort", onAbort)
    expect(Object.keys(ctx)).toEqual(expect.arrayContaining(["config", "data", "lifecycle"]))
    expect(ctx.config).toEqual({ enabled: false })
    configuration = { enabled: true }
    expect(ctx.config).toEqual({ enabled: true })
    await scopes.get("a")!.dispose()
    expect(lifetime.aborted).toBe(true)
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(() => first.read()).toThrow("activation has ended")
  })

  it("preserves event callback identity and fences delivered host handles", async () => {
    let listener!: (handle: { read(): string }) => void
    const on = jest.fn((_event: string, handler: typeof listener) => {
      listener = handler
    })
    const off = jest.fn()
    let ctx!: { events: { on: typeof on; off: typeof off } }
    load.mockResolvedValue({
      default: (value: typeof ctx) => {
        ctx = value
        return { exports: {} }
      },
    })
    await modules.importModule("a", "lib", "utils", {
      events: { on, off },
    } as unknown as FullPluginContext)
    let retained!: { read(): string }
    const callback = jest.fn((handle) => {
      retained = handle
    })
    ctx.events.on("change", callback)
    listener({ read: () => "ready" })
    expect(retained.read()).toBe("ready")
    ctx.events.off("change", callback)
    expect(off.mock.calls[0][1]).toBe(on.mock.calls[0][1])
    await scopes.get("a")!.dispose()
    expect(() => retained.read()).toThrow("activation has ended")
    expect(() => listener({ read: () => "late" })).toThrow("activation has ended")
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it("rejects suspended providers and never allocates a new scope from a retained host call", async () => {
    const exports = await modules.importModule<{ host(): string }>("a", "lib", "utils", context)
    scopes.delete("lib")
    expect(() => exports.host()).toThrow("activation has ended")
    provider.status = "suspended"
    await expect(modules.importModule("a", "lib", "utils", context)).rejects.toThrow(
      "provider is suspended"
    )
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("does not cache failed factories and rejects undeclared modules and Python imports", async () => {
    load.mockRejectedValueOnce(new Error("bundle failed"))
    await expect(modules.importModule("a", "lib", "utils", context)).rejects.toThrow(
      "bundle failed"
    )
    await expect(modules.importModule("a", "lib", "utils", context)).resolves.toBeDefined()
    await expect(modules.importModule("a", "lib", "toString", context)).rejects.toThrow(
      "not declared"
    )
    provider.manifest.type = "python"
    await expect(modules.importModule("a", "lib", "utils", context)).rejects.toThrow(
      "ordinary JavaScript"
    )
  })
})
