import { validatePluginRealmId, type PluginRealmId } from "./realm"

export type PluginDisposer = () => void | Promise<void>

export interface PluginDisposalFailure {
  label: string
  error: unknown
}

export interface PluginDisposalReport {
  disposed: number
  failures: PluginDisposalFailure[]
}

export interface PluginDisposableScopeDiagnostics {
  active: number
  pending: number
  failed: number
  labels: string[]
}

interface LedgerEntry {
  label: string
  dispose: PluginDisposer
  state: "active" | "disposing" | "failed" | "disposed"
  attempt: number
}

export interface PluginDisposableScopeOptions {
  disposeTimeoutMs?: number
  pendingGraceMs?: number
  realmId?: PluginRealmId
  scopeId?: string
}

export interface PluginScopeToken {
  realmId: PluginRealmId
  pluginId: string
  generation: number
  scopeId: string
}

export type PluginResourceEffect =
  | { kind: "none" }
  | { kind: "returned-disposer" }
  | { kind: "returned-handle"; disposeMethod: string }
  | { kind: "host-owned" }

export type PluginResourceEffectMap = Readonly<Record<string, PluginResourceEffect>>

/**
 * Teardown phase. The distinction between `draining` and `sweeping` matters:
 * a resource that lands while we are still waiting for pending registrations
 * is picked up by the upcoming sweep, but one that lands *during* the sweep is
 * no longer covered by the sweep's entry snapshot and has to dispose itself.
 * Collapsing the two into a single `closed` flag leaks the second case.
 */
type ScopePhase = "open" | "draining" | "sweeping" | "closed"

/** Lifecycle ledger for resources returned by a plugin's ctx.* registrations. */
export class PluginDisposableScope {
  private readonly entries: LedgerEntry[] = []
  private readonly children: PluginDisposableScope[] = []
  private readonly pendingRegistrations = new Set<Promise<void>>()
  private readonly pendingLabels = new Map<Promise<void>, string>()
  private phase: ScopePhase = "open"
  private readonly abortController = new AbortController()

  constructor(
    readonly pluginId: string,
    readonly generation = 0,
    private readonly options: PluginDisposableScopeOptions = {}
  ) {
    validatePluginRealmId(options.realmId ?? "global")
  }

  get realmId(): PluginRealmId {
    return this.options.realmId ?? "global"
  }

  get scopeId(): string {
    return this.options.scopeId ?? "root"
  }

  get token(): PluginScopeToken {
    return Object.freeze({
      realmId: this.realmId,
      pluginId: this.pluginId,
      generation: this.generation,
      scopeId: this.scopeId,
    })
  }

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  /**
   * Enrol a disposer and hand back a ledger-bound handle.
   *
   * The returned function — not the raw disposer — is what callers must expose
   * to the plugin: it routes through {@link disposeEntry}, which is idempotent,
   * so a plugin that tears its own resource down in `deactivate()` does not get
   * that same disposer invoked a second time by the teardown sweep.
   */
  track(dispose: PluginDisposer, label: string): PluginDisposer {
    const entry: LedgerEntry = { label, dispose, state: "active", attempt: 0 }
    this.entries.push(entry)
    // `draining` still has a sweep ahead of it, which will pick this entry up
    // from its snapshot. `sweeping`/`closed` do not, so dispose right away.
    if (this.phase === "sweeping" || this.phase === "closed") {
      void this.disposeEntry(entry).catch(() => undefined)
    }
    return () => this.disposeEntry(entry)
  }

  trackFor(token: PluginScopeToken, dispose: PluginDisposer, label: string): PluginDisposer {
    if (
      token.realmId !== this.realmId ||
      token.pluginId !== this.pluginId ||
      token.generation !== this.generation ||
      token.scopeId !== this.scopeId
    ) {
      throw new Error(`Invalid plugin scope token for ${this.pluginId}:${this.scopeId}`)
    }
    return this.track(dispose, label)
  }

  createChildScope(scopeId: string, realmId: PluginRealmId = this.realmId): PluginDisposableScope {
    if (!scopeId || this.children.some((child) => child.scopeId === scopeId)) {
      throw new Error(`Duplicate or empty child scope id for ${this.pluginId}: ${scopeId}`)
    }
    const child = new PluginDisposableScope(this.pluginId, this.generation, {
      ...this.options,
      realmId,
      scopeId,
    })
    this.children.push(child)
    // Child disposal iterates over a snapshot. Once parent teardown starts, a
    // child created while an earlier child is still disposing would otherwise
    // miss that snapshot and survive the generation.
    if (this.phase !== "open") {
      void child.dispose().catch(() => undefined)
    }
    return child
  }

  /**
   * Track a registration that resolves later, keeping the scope's teardown
   * blocked on it. `adopt` runs on the resolved value and returns whatever the
   * caller should receive — typically the ledger-bound disposer from
   * {@link track} rather than the plugin's raw one.
   */
  trackAsyncRegistration<T>(
    registration: Promise<T>,
    label: string,
    adopt: (value: T) => T
  ): Promise<T> {
    let resolveSettled!: () => void
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    this.pendingRegistrations.add(settled)
    this.pendingLabels.set(settled, label)
    const finish = (): void => {
      this.pendingRegistrations.delete(settled)
      this.pendingLabels.delete(settled)
      resolveSettled()
    }
    return registration.then(
      (value) => {
        try {
          return adopt(value)
        } finally {
          finish()
        }
      },
      (error) => {
        finish()
        throw error
      }
    )
  }

  trackPendingWork<T>(work: Promise<T>, label: string): Promise<T> {
    const settled = work
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        this.pendingRegistrations.delete(settled)
        this.pendingLabels.delete(settled)
      })
    this.pendingRegistrations.add(settled)
    this.pendingLabels.set(settled, label)
    return work
  }

  async dispose(): Promise<PluginDisposalReport> {
    if (this.phase === "open") {
      this.phase = "draining"
      this.abortController.abort()
    }
    let disposed = 0
    const failures: PluginDisposalFailure[] = []
    for (const child of [...this.children].reverse()) {
      const report = await child.dispose()
      disposed += report.disposed
      failures.push(
        ...report.failures.map((failure) => ({
          label: `child:${child.scopeId}/${failure.label}`,
          error: failure.error,
        }))
      )
    }
    if (this.pendingRegistrations.size > 0) {
      await this.waitForPendingRegistrations()
    }
    // From here the sweep works off a snapshot, so anything that arrives later
    // is invisible to it — `track` disposes those itself while we are in this
    // phase. Set it before taking the snapshot so there is no uncovered gap.
    this.phase = "sweeping"
    for (const entry of [...this.entries].reverse()) {
      if (entry.state === "disposed" || entry.state === "disposing") continue
      try {
        await this.disposeEntry(entry)
        disposed += 1
      } catch (error) {
        failures.push({ label: entry.label, error })
      }
    }
    this.phase = "closed"
    if (this.pendingRegistrations.size > 0) {
      failures.push({
        label: "pending-registration",
        error: new Error(
          `Plugin ${this.pluginId} generation ${this.generation} still has pending registrations`
        ),
      })
    }
    return { disposed, failures }
  }

  hasUnresolvedResources(): boolean {
    return (
      this.pendingRegistrations.size > 0 ||
      this.entries.some((entry) => entry.state !== "disposed") ||
      this.children.some((child) => child.hasUnresolvedResources())
    )
  }

  getUnresolvedLabels(limit = 20): string[] {
    return this.entries
      .filter((entry) => entry.state !== "disposed")
      .map((entry) => entry.label.slice(0, 128))
      .concat([...this.pendingLabels.values()].map((label) => label.slice(0, 128)))
      .concat(
        this.children.flatMap((child) =>
          child
            .getUnresolvedLabels(limit)
            .map((label) => `child:${child.scopeId}/${label}`.slice(0, 128))
        )
      )
      .slice(0, Math.max(0, limit))
  }

  getDiagnostics(limit = 20): PluginDisposableScopeDiagnostics {
    const childDiagnostics = this.children.map((child) => child.getDiagnostics(limit))
    return {
      active:
        this.entries.filter((entry) => entry.state === "active" || entry.state === "disposing")
          .length + childDiagnostics.reduce((sum, child) => sum + child.active, 0),
      pending:
        this.pendingRegistrations.size +
        childDiagnostics.reduce((sum, child) => sum + child.pending, 0),
      failed:
        this.entries.filter((entry) => entry.state === "failed").length +
        childDiagnostics.reduce((sum, child) => sum + child.failed, 0),
      labels: this.getUnresolvedLabels(limit),
    }
  }

  private async waitForPendingRegistrations(): Promise<void> {
    const pending = Promise.allSettled([...this.pendingRegistrations]).then(() => undefined)
    const graceMs = this.options.pendingGraceMs ?? 1_000
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        setTimeout(resolve, graceMs)
      }),
    ])
  }

  private async disposeEntry(entry: LedgerEntry): Promise<void> {
    if (entry.state === "disposed" || entry.state === "disposing") return
    entry.state = "disposing"
    entry.attempt += 1
    const attempt = entry.attempt
    const disposal = Promise.resolve().then(entry.dispose)
    void disposal.then(
      () => {
        if (entry.attempt === attempt) entry.state = "disposed"
      },
      () => {
        if (entry.attempt === attempt) entry.state = "failed"
      }
    )
    const timeoutMs = this.options.disposeTimeoutMs ?? 2_000
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        disposal,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Timed out disposing ${entry.label} after ${timeoutMs}ms`)),
            timeoutMs
          )
        }),
      ])
      if (entry.attempt === attempt) entry.state = "disposed"
    } catch (error) {
      if (entry.attempt === attempt) entry.state = "failed"
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

function isDisposableResult(value: unknown): value is PluginDisposer {
  return typeof value === "function"
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Preserves the API shape while enrolling returned disposer functions in the
 * plugin scope. Arguments and results are otherwise passed through unchanged.
 */
export function withPluginDisposableScope<T extends object>(
  scope: PluginDisposableScope,
  namespace: string,
  api: T,
  resourceEffects: PluginResourceEffectMap = {}
): T {
  const nested = new WeakMap<object, object>()
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (value && typeof value === "object" && isPlainObject(value)) {
        const cached = nested.get(value)
        if (cached) return cached
        const wrapped = withPluginDisposableScope(
          scope,
          `${namespace}.${String(property)}`,
          value,
          resourceEffects
        )
        nested.set(value, wrapped)
        return wrapped
      }
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        const result = value.apply(target, args)
        const label = `${namespace}.${String(property)}`
        const effect = resourceEffects[label]
        if (effect?.kind === "none" || effect?.kind === "host-owned") return result
        const expectsDisposer = effect?.kind === "returned-disposer"
        // Hands back the ledger-bound disposer, never the plugin's raw one, so
        // a plugin disposing its own resource marks the ledger entry and the
        // teardown sweep does not invoke that disposer a second time.
        const adopt = (resolved: unknown): unknown => {
          if (expectsDisposer && isDisposableResult(resolved)) {
            return scope.track(resolved, label)
          }
          if (effect?.kind === "returned-handle" && resolved && typeof resolved === "object") {
            const method = Reflect.get(resolved, effect.disposeMethod)
            if (typeof method === "function") {
              const tracked = scope.track(() => method.call(resolved), label)
              try {
                Reflect.set(resolved, effect.disposeMethod, tracked)
              } catch {
                // Frozen handle: the ledger still owns teardown, the plugin's
                // own call just bypasses the idempotency guard.
              }
            }
          }
          return resolved
        }
        if (result instanceof Promise) {
          return scope.trackAsyncRegistration(result, label, adopt)
        }
        return adopt(result)
      }
    },
  })
}
