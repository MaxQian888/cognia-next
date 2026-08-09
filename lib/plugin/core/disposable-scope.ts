export type PluginDisposer = () => void | Promise<void>

export interface PluginDisposalFailure {
  label: string
  error: unknown
}

export interface PluginDisposalReport {
  disposed: number
  failures: PluginDisposalFailure[]
}

interface LedgerEntry {
  label: string
  dispose: PluginDisposer
  disposed: boolean
}

/** Lifecycle ledger for resources returned by a plugin's ctx.* registrations. */
export class PluginDisposableScope {
  private readonly entries: LedgerEntry[] = []
  private closed = false

  constructor(readonly pluginId: string) {}

  track(dispose: PluginDisposer, label: string): PluginDisposer {
    if (this.closed) {
      void Promise.resolve()
        .then(dispose)
        .catch(() => undefined)
      return () => undefined
    }
    const entry: LedgerEntry = { label, dispose, disposed: false }
    this.entries.push(entry)
    return async () => {
      if (entry.disposed) return
      entry.disposed = true
      await entry.dispose()
    }
  }

  async dispose(): Promise<PluginDisposalReport> {
    if (this.closed) return { disposed: 0, failures: [] }
    this.closed = true
    let disposed = 0
    const failures: PluginDisposalFailure[] = []
    for (const entry of [...this.entries].reverse()) {
      if (entry.disposed) continue
      entry.disposed = true
      try {
        await entry.dispose()
        disposed += 1
      } catch (error) {
        failures.push({ label: entry.label, error })
      }
    }
    this.entries.length = 0
    return { disposed, failures }
  }
}

function isDisposableResult(value: unknown): value is PluginDisposer {
  return typeof value === "function"
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function returnsOwnedDisposable(method: string): boolean {
  const name = method.split(".").at(-1) ?? method
  return (
    name === "subscribe" ||
    name === "watch" ||
    name === "expose" ||
    name.startsWith("register") ||
    name.startsWith("on")
  )
}

/**
 * Preserves the API shape while enrolling returned disposer functions in the
 * plugin scope. Arguments and results are otherwise passed through unchanged.
 */
export function withPluginDisposableScope<T extends object>(
  scope: PluginDisposableScope,
  namespace: string,
  api: T
): T {
  const nested = new WeakMap<object, object>()
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (value && typeof value === "object" && isPlainObject(value)) {
        const cached = nested.get(value)
        if (cached) return cached
        const wrapped = withPluginDisposableScope(scope, `${namespace}.${String(property)}`, value)
        nested.set(value, wrapped)
        return wrapped
      }
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        const result = value.apply(target, args)
        const label = `${namespace}.${String(property)}`
        if (!returnsOwnedDisposable(label)) return result
        if (isDisposableResult(result)) return scope.track(result, label)
        if (result instanceof Promise) {
          return result.then((resolved) =>
            isDisposableResult(resolved) ? scope.track(resolved, label) : resolved
          )
        }
        return result
      }
    },
  })
}
