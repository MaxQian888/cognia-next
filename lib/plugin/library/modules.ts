import type { Plugin } from "@/types/plugin"
import type { FullPluginContext } from "../core/context"
import { PluginDisposableScope, withPluginDisposableScope } from "../core/disposable-scope"
import { PLUGIN_RESOURCE_EFFECTS } from "../core/resource-effects"
import { loggers } from "../core/logger"
import { assertLibraryAccess, authorizeLibraryAccess } from "./access"

export class LibraryModuleError extends Error {
  constructor(
    readonly code: "disposed" | "unsupported-runtime" | "invalid-module",
    message: string
  ) {
    super(message)
    this.name = "LibraryModuleError"
  }
}

interface ModuleHost {
  getPluginDisposableScope(pluginId: string): PluginDisposableScope
  peekPluginDisposableScope(pluginId: string): PluginDisposableScope | undefined
  importLibraryEntry(provider: Plugin, entry: string): Promise<Record<string, unknown>>
}

interface ModuleInstance {
  exports: Record<string, unknown>
  dispose?: () => void | Promise<void>
}

/** Preserve host value shapes while fencing methods and handles retained by a module. */
function fenceContext<T extends object>(context: T, check: () => void): T {
  const cache = new WeakMap<object, object>()
  const originals = new WeakMap<object, object>()
  type Callable = (...args: unknown[]) => unknown
  const callbacks = new WeakMap<Callable, Callable>()
  const methods = new WeakMap<object, WeakMap<object, object>>()
  const unwrap = (value: unknown) =>
    value && (typeof value === "object" || typeof value === "function")
      ? (originals.get(value as object) ?? value)
      : value
  const argument = (value: unknown): unknown => {
    if (typeof value !== "function") return unwrap(value)
    const original = originals.get(value)
    if (original) return original
    const cached = callbacks.get(value as Callable)
    if (cached) return cached
    const callback = function (this: unknown, ...args: unknown[]) {
      check()
      return Reflect.apply(
        value,
        this,
        args.map((arg) => wrap(arg))
      )
    }
    callbacks.set(value as Callable, callback)
    return callback
  }
  const wrap = (value: unknown, owner?: object, property?: PropertyKey): unknown => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return value
    // A real signal must remain observable during teardown and usable by native APIs.
    if (value instanceof AbortSignal) return value
    if (value instanceof Promise)
      return value.then((result) => {
        check()
        return wrap(result)
      })
    let values = cache
    if (typeof value === "function" && owner) {
      let ownerMethods = methods.get(owner)
      if (!ownerMethods) {
        ownerMethods = new WeakMap()
        methods.set(owner, ownerMethods)
      }
      values = ownerMethods
    }
    const cached = values.get(value as object)
    if (cached) return cached
    // Shadow targets preserve arrays/prototypes without frozen-property invariants.
    // A bound function has no non-configurable own prototype/caller/arguments keys.
    const target =
      typeof value === "function"
        ? function () {}.bind(undefined)
        : Array.isArray(value)
          ? new Array(value.length)
          : Object.create(Object.getPrototypeOf(value))
    const proxy = new Proxy(target, {
      get: (_target, key) => {
        check()
        return wrap(Reflect.get(value as object, key, value), value as object, key)
      },
      apply: (_target, receiver, args) => {
        check()
        return wrap(
          Reflect.apply(
            value as Callable,
            owner ?? unwrap(receiver),
            // Teardown callbacks must run after the lifetime fence closes.
            property === "onDispose" ? args : args.map(argument)
          )
        )
      },
      construct: (_target, args) => {
        check()
        return wrap(
          Reflect.construct(value as new (...args: unknown[]) => object, args.map(argument))
        ) as object
      },
      ownKeys: () => {
        check()
        return Reflect.ownKeys(value as object)
      },
      has: (_target, key) => {
        check()
        return Reflect.has(value as object, key)
      },
      getOwnPropertyDescriptor: (_target, key) => {
        check()
        if (Array.isArray(value) && key === "length") {
          target.length = value.length
          return Reflect.getOwnPropertyDescriptor(target, key)
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value as object, key)
        return descriptor
          ? {
              configurable: true,
              enumerable: descriptor.enumerable,
              value: wrap(Reflect.get(value as object, key), value as object),
              writable: false,
            }
          : undefined
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      setPrototypeOf: () => false,
      preventExtensions: () => false,
    })
    values.set(value as object, proxy)
    originals.set(proxy, value as object)
    return proxy
  }
  return wrap(context) as T
}

/** One independently evaluated CJS module per consumer activation and provider generation. */
export class PluginLibraryModules {
  private readonly instances = new WeakMap<
    PluginDisposableScope,
    Map<string, Promise<Record<string, unknown>>>
  >()
  private readonly providerIds = new WeakMap<PluginDisposableScope, number>()
  private sequence = 0

  constructor(private readonly host: ModuleHost) {}

  async importModule<T extends Record<string, unknown>>(
    consumerId: string,
    providerId: string,
    moduleName: string,
    context: FullPluginContext
  ): Promise<T> {
    const started = Date.now()
    let outcome: "success" | "failure" = "failure"
    let version: string | null = null
    let risk: string | null = null
    try {
      const { caller, provider } = assertLibraryAccess(consumerId, providerId)
      version = provider.manifest.version
      if (provider.status === "suspended") {
        throw new LibraryModuleError("disposed", "Library module provider is suspended")
      }
      for (const plugin of [caller, provider]) {
        if (
          !["frontend", "hybrid"].includes(plugin.manifest.type) ||
          plugin.manifest.engines?.node ||
          plugin.manifest.runtimeCompatibility?.tauri?.entrypoint === "node"
        ) {
          throw new LibraryModuleError(
            "unsupported-runtime",
            "Direct library modules require the ordinary JavaScript runtime"
          )
        }
      }
      const modules = provider.manifest.library?.modules
      if (!modules || !Object.prototype.hasOwnProperty.call(modules, moduleName)) {
        throw new LibraryModuleError(
          "invalid-module",
          `Library module is not declared: ${providerId}/${moduleName}`
        )
      }
      const declaration = modules[moduleName]
      risk = declaration.risk
      const consumerScope = this.host.getPluginDisposableScope(consumerId)
      const providerScope = this.host.getPluginDisposableScope(providerId)
      const checkScopes = () => {
        if (
          consumerScope.signal.aborted ||
          providerScope.signal.aborted ||
          this.host.peekPluginDisposableScope(consumerId) !== consumerScope ||
          this.host.peekPluginDisposableScope(providerId) !== providerScope
        ) {
          throw new LibraryModuleError("disposed", "Library module activation has ended")
        }
      }
      checkScopes()
      const recheck = await authorizeLibraryAccess(
        consumerId,
        providerId,
        declaration.requiredPermissions,
        `libraries.importModule:${moduleName}`
      )
      checkScopes()
      recheck()
      let instances = this.instances.get(consumerScope)
      if (!instances) {
        instances = new Map()
        this.instances.set(consumerScope, instances)
      }
      if (!this.providerIds.has(providerScope)) this.providerIds.set(providerScope, ++this.sequence)
      const key = JSON.stringify([providerId, this.providerIds.get(providerScope), moduleName])
      const cached = instances.get(key)
      if (cached) {
        const exports = await cached
        checkScopes()
        recheck()
        outcome = "success"
        return exports as T
      }
      const child = consumerScope.createChildScope(
        `library:${++this.sequence}:${providerId}:${moduleName}`
      )
      const check = () => {
        checkScopes()
        if (child.signal.aborted)
          throw new LibraryModuleError("disposed", "Library module was disposed")
        recheck()
      }
      const scopedContext = withPluginDisposableScope(
        child,
        "ctx",
        Object.create(Object.getPrototypeOf(context), {
          ...Object.fromEntries(
            Reflect.ownKeys(context).map((key) => [
              key,
              {
                enumerable: Reflect.getOwnPropertyDescriptor(context, key)?.enumerable ?? true,
                configurable: true,
                get: () => Reflect.get(context, key),
              },
            ])
          ),
          lifecycle: {
            enumerable: true,
            configurable: true,
            value: {
              signal: child.signal,
              onDispose: (dispose: () => void | Promise<void>, label = "library.lifecycle") => {
                child.track(dispose, label)
              },
            },
          },
        }),
        PLUGIN_RESOURCE_EFFECTS
      ) as FullPluginContext
      const initialize = async () => {
        try {
          const bundle = await this.host.importLibraryEntry(provider, declaration.entry)
          check()
          if (typeof bundle.default !== "function")
            throw new LibraryModuleError(
              "invalid-module",
              "Library entry must default-export a factory"
            )
          const instance = (await bundle.default(
            fenceContext(scopedContext, check)
          )) as ModuleInstance
          if (instance && typeof instance.dispose === "function") {
            // Register before checking lifetime so teardown also owns a late factory result.
            const dispose = child.track(() => instance.dispose!(), "library.dispose")
            if (
              child.signal.aborted ||
              consumerScope.signal.aborted ||
              providerScope.signal.aborted
            )
              await dispose()
          }
          if (
            !instance ||
            typeof instance.exports !== "object" ||
            instance.exports === null ||
            Array.isArray(instance.exports) ||
            (instance.dispose !== undefined && typeof instance.dispose !== "function")
          ) {
            throw new LibraryModuleError(
              "invalid-module",
              "Library factory must return { exports, dispose? }"
            )
          }
          check()
          return instance.exports
        } catch (error) {
          instances!.delete(key)
          await child.dispose()
          throw error
        }
      }
      // Parent owns pending work: child disposal must not wait on a promise that itself disposes the child.
      const pending = consumerScope.trackPendingWork(
        initialize(),
        `library:${providerId}/${moduleName}`
      )
      instances.set(key, pending)
      const exports = await pending
      check()
      outcome = "success"
      return exports as T
    } finally {
      // Safe metadata only: factory results, context, and error payloads may contain user data.
      loggers.manager.info("Library module import", {
        callerId: consumerId,
        providerId,
        module: moduleName,
        version,
        risk,
        outcome,
        durationMs: Date.now() - started,
        timestamp: started,
      })
    }
  }
}
