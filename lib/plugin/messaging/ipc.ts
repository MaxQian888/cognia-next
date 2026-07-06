/**
 * Plugin IPC (Inter-Plugin Communication)
 *
 * Enables secure communication between plugins through:
 * - Direct messaging between plugins
 * - Broadcast messaging to all plugins
 * - RPC-style method calls
 * - Typed event subscriptions
 */

import type { PluginPermission } from "@/types/plugin"
import { withTimeout } from "@cognia/primitives"
import { createCircuitBreaker, type CircuitBreaker } from "@/lib/connectors/circuit-breaker"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { loggers } from "../core/logger"
import { pluginHasApiPermission } from "@/lib/plugin/api/permission-api"
import { PLUGIN_MESSAGE_HISTORY_MAX } from "./constants"
import type {
  PluginIPCAPI,
  PluginIPCCallOptions,
  IpcMethodSchema,
  IpcExposedMethods,
  IpcExposedMethodDescriptor,
  IpcExposedMethodInfo,
} from "@/types/plugin/plugin-messaging"

// Re-export the messaging type contracts (single source of truth in `types/`).
export type {
  PluginIPCAPI,
  PluginIPCCallOptions,
  IpcMethodSchema,
  IpcExposedMethods,
  IpcExposedMethodInfo,
}

// =============================================================================
// Types
// =============================================================================

/**
 * Thrown when a call hits a breaker in `open` state — distinct from
 * `TimeoutError` so callers can choose to retry against another
 * target / surface a different UX.
 */
export class CircuitOpenError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly methodName: string
  ) {
    super(`IPC breaker open for ${pluginId}.${methodName}`)
    this.name = "CircuitOpenError"
  }
}

/**
 * Thrown when a caller-supplied AbortSignal fires before the handler
 * settles. Matches the conventional `AbortError` name browsers /
 * `fetch` use so callers can pattern-match by `err.name === "AbortError"`.
 */
export class IPCAbortError extends Error {
  constructor(reason?: string) {
    super(reason ?? "IPC call aborted")
    this.name = "AbortError"
  }
}

/**
 * Thrown when a `call()` argument list doesn't satisfy the target method's
 * declared {@link IpcMethodSchema}. A schema violation is a caller bug, so it
 * is raised BEFORE the breaker / handler — it never charges the endpoint a
 * failure and the remote handler is never invoked.
 */
export class IPCSchemaError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly methodName: string,
    public readonly detail: string
  ) {
    super(`IPC call to ${pluginId}.${methodName} failed argument validation: ${detail}`)
    this.name = "IPCSchemaError"
  }
}

const IPC_ARG_VALIDATORS: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  unknown: () => true,
}

/**
 * Validate positional `args` against a method `schema`. Returns a human-readable
 * error string on the first mismatch, or `null` when the args are valid. Trailing
 * optional args may be omitted; extra args beyond the schema are rejected so a
 * typo'd method signature surfaces instead of being silently dropped.
 */
export function validateIpcArgs(schema: IpcMethodSchema, args: unknown[]): string | null {
  const params = schema.args
  if (!params) return null

  const required = params.filter((p) => !p.optional).length
  if (args.length < required) {
    return `expected at least ${required} argument(s), received ${args.length}`
  }
  if (args.length > params.length) {
    return `expected at most ${params.length} argument(s), received ${args.length}`
  }

  for (let i = 0; i < params.length; i++) {
    const param = params[i]
    if (i >= args.length) {
      // Missing trailing arg — already validated as optional above.
      continue
    }
    const validate = IPC_ARG_VALIDATORS[param.type] ?? IPC_ARG_VALIDATORS.unknown
    if (!validate(args[i])) {
      return `argument ${i} expected type "${param.type}"`
    }
  }
  return null
}

export interface IPCMessage {
  id: string
  type: "request" | "response" | "broadcast" | "event"
  channel: string
  senderId: string
  targetId?: string
  payload: unknown
  timestamp: number
  replyTo?: string
}

export interface IPCRequest {
  id: string
  method: string
  args: unknown[]
  timeout: number
}

export interface IPCSubscription {
  channel: string
  pluginId: string
  handler: (data: unknown, senderId: string) => void
  filter?: (senderId: string) => boolean
}

export interface ExposedMethod {
  name: string
  pluginId: string
  handler: (...args: unknown[]) => unknown | Promise<unknown>
  description?: string
  schema?: IpcMethodSchema
}

export interface IPCConfig {
  defaultTimeout: number
  maxMessageSize: number
  enableLogging: boolean
  requirePermission: boolean
}

type MessageHandler = (data: unknown, senderId: string) => void

// =============================================================================
// Plugin IPC Manager
// =============================================================================

/**
 * `IPCConfig.maxHistory` is optional; when omitted the bus uses
 * `PLUGIN_MESSAGE_HISTORY_MAX` so both PluginIPC and MessageBus stay
 * aligned. PR-C sourced both surfaces from the same constant — the
 * legacy `100` cap inside PluginIPC was never documented and broke
 * parity with MessageBus's 500.
 */

export class PluginIPC {
  private config: IPCConfig
  private subscriptions: Map<string, Set<IPCSubscription>> = new Map()
  private exposedMethods: Map<string, Map<string, ExposedMethod>> = new Map()
  private messageHistory: IPCMessage[] = []
  private readonly maxHistory: number
  private pluginPermissions: Map<string, Set<PluginPermission>> = new Map()
  /**
   * One breaker per `(targetPluginId, methodName)` pair. Created
   * lazily on first call so the breaker map only grows for endpoints
   * that have actually been exercised.
   */
  private breakers: Map<string, CircuitBreaker> = new Map()
  /**
   * Tracks the last observed state per breaker so we only emit one
   * `recordSilentFailure` on the `closed → open` transition rather
   * than spamming on every short-circuited call.
   */
  private breakerStates: Map<string, "closed" | "open" | "half_open"> = new Map()

  constructor(config: Partial<IPCConfig> & { maxHistory?: number } = {}) {
    this.config = {
      defaultTimeout: 30000,
      maxMessageSize: 1024 * 1024, // 1MB
      enableLogging: false,
      requirePermission: false,
      ...config,
    }
    this.maxHistory = config.maxHistory ?? PLUGIN_MESSAGE_HISTORY_MAX
  }

  // ===========================================================================
  // Plugin Registration
  // ===========================================================================

  registerPlugin(pluginId: string, permissions: PluginPermission[] = []): void {
    this.pluginPermissions.set(pluginId, new Set(permissions))
    this.exposedMethods.set(pluginId, new Map())
  }

  unregisterPlugin(pluginId: string): void {
    // Remove all subscriptions for this plugin
    for (const [channel, subs] of this.subscriptions.entries()) {
      for (const sub of subs) {
        if (sub.pluginId === pluginId) {
          subs.delete(sub)
        }
      }
      if (subs.size === 0) {
        this.subscriptions.delete(channel)
      }
    }

    // Remove exposed methods
    this.exposedMethods.delete(pluginId)

    // Remove permissions
    this.pluginPermissions.delete(pluginId)
  }

  // ===========================================================================
  // Direct Messaging
  // ===========================================================================

  async send(senderId: string, targetId: string, channel: string, data: unknown): Promise<void> {
    this.validateMessage(data)

    const message: IPCMessage = {
      id: this.generateId(),
      type: "request",
      channel,
      senderId,
      targetId,
      payload: data,
      timestamp: Date.now(),
    }

    this.recordMessage(message)
    this.log("send", message)

    // Deliver to target plugin's subscriptions
    const subs = this.subscriptions.get(channel)
    if (subs) {
      for (const sub of subs) {
        if (sub.pluginId === targetId) {
          if (!sub.filter || sub.filter(senderId)) {
            try {
              sub.handler(data, senderId)
            } catch (error) {
              loggers.manager.error(`[IPC] Handler error in ${targetId}:`, error)
            }
          }
        }
      }
    }
  }

  // NOTE: a request/response `sendAndWait` + `respond` pair previously lived
  // here, but the reply path was structurally dead — `respond` was never on the
  // plugin-facing `PluginIPCAPI`, the receiver was never handed the `requestId`
  // to correlate a reply, so every façade-level `sendAndWait` hung to timeout.
  // It was removed; `call()` + `expose()` is the supported request-response RPC
  // (with circuit-breaker + schema validation + size cap).

  // ===========================================================================
  // Broadcasting
  // ===========================================================================

  broadcast(senderId: string, channel: string, data: unknown): void {
    this.validateMessage(data)

    const message: IPCMessage = {
      id: this.generateId(),
      type: "broadcast",
      channel,
      senderId,
      payload: data,
      timestamp: Date.now(),
    }

    this.recordMessage(message)
    this.log("broadcast", message)

    // Deliver to all subscribers except sender
    const subs = this.subscriptions.get(channel)
    if (subs) {
      for (const sub of subs) {
        if (sub.pluginId !== senderId) {
          if (!sub.filter || sub.filter(senderId)) {
            try {
              sub.handler(data, senderId)
            } catch (error) {
              loggers.manager.error(`[IPC] Broadcast handler error in ${sub.pluginId}:`, error)
            }
          }
        }
      }
    }
  }

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  subscribe(
    pluginId: string,
    channel: string,
    handler: MessageHandler,
    filter?: (senderId: string) => boolean
  ): () => void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set())
    }

    const subscription: IPCSubscription = {
      channel,
      pluginId,
      handler,
      filter,
    }

    this.subscriptions.get(channel)!.add(subscription)

    // Return unsubscribe function
    return () => {
      const subs = this.subscriptions.get(channel)
      if (subs) {
        subs.delete(subscription)
        if (subs.size === 0) {
          this.subscriptions.delete(channel)
        }
      }
    }
  }

  unsubscribe(pluginId: string, channel?: string): void {
    if (channel) {
      const subs = this.subscriptions.get(channel)
      if (subs) {
        for (const sub of subs) {
          if (sub.pluginId === pluginId) {
            subs.delete(sub)
          }
        }
      }
    } else {
      // Unsubscribe from all channels
      for (const subs of this.subscriptions.values()) {
        for (const sub of subs) {
          if (sub.pluginId === pluginId) {
            subs.delete(sub)
          }
        }
      }
    }
  }

  // ===========================================================================
  // RPC (Remote Procedure Call)
  // ===========================================================================

  expose(pluginId: string, methods: IpcExposedMethods): void {
    const methodMap = this.exposedMethods.get(pluginId) || new Map()

    for (const [name, value] of Object.entries(methods)) {
      // Back-compat: a bare function exposes a handler with no schema; a
      // descriptor `{ handler, schema?, description? }` carries arg validation
      // + discovery metadata.
      const descriptor: IpcExposedMethodDescriptor =
        typeof value === "function" ? { handler: value } : value
      methodMap.set(name, {
        name,
        pluginId,
        handler: descriptor.handler,
        description: descriptor.description ?? descriptor.schema?.description,
        schema: descriptor.schema,
      })
    }

    this.exposedMethods.set(pluginId, methodMap)
  }

  unexpose(pluginId: string, methodName?: string): void {
    if (methodName) {
      this.exposedMethods.get(pluginId)?.delete(methodName)
    } else {
      this.exposedMethods.delete(pluginId)
    }
  }

  /**
   * Invoke a method on another plugin under timeout + AbortSignal +
   * per-endpoint circuit breaker.
   *
   * Behaviour:
   *  - `options.timeoutMs` defaults to `config.defaultTimeout` (30s).
   *    Pass `0` or negative to disable. On expiry the call rejects
   *    with `TimeoutError`; the handler keeps running in the
   *    background (JS has no general way to cancel a promise).
   *  - `options.signal`, when aborted, rejects with `IPCAbortError`
   *    (name `"AbortError"`). The breaker is NOT charged a failure
   *    for aborts — the caller chose to bail.
   *  - The per-`(targetPluginId, methodName)` breaker uses
   *    `createCircuitBreaker` defaults (window 30 s, 50% failure
   *    threshold over ≥5 events, 30 s cooldown, 3 successes to
   *    close). A breaker in `open` rejects synchronously with
   *    `CircuitOpenError` and emits `recordSilentFailure` once per
   *    `closed → open` transition.
   */
  async call<T>(
    callerId: string,
    targetPluginId: string,
    methodName: string,
    args: unknown[] = [],
    options: PluginIPCCallOptions = {}
  ): Promise<T> {
    let methodMap = this.exposedMethods.get(targetPluginId)
    let method = methodMap?.get(methodName)

    // Idle-suspend wake: if the target's methods aren't exposed because it was
    // idle-suspended (deactivatePluginRuntime → unexpose clears exposedMethods),
    // resume it and retry the lookup once — mirroring how the agent-tool path
    // wakes a suspended plugin via handleActivationEvent. Without this, the
    // first cross-plugin RPC after the idle window throws "no exposed methods"
    // instead of waking the provider plugin.
    if (!methodMap || !method) {
      if (await this.tryResumeSuspendedTarget(targetPluginId)) {
        methodMap = this.exposedMethods.get(targetPluginId)
        method = methodMap?.get(methodName)
      }
    }

    if (!methodMap) {
      throw new Error(`Plugin ${targetPluginId} has no exposed methods`)
    }
    if (!method) {
      throw new Error(`Method ${methodName} not found in plugin ${targetPluginId}`)
    }

    // Arg validation runs before the breaker so a caller's bad arguments never
    // open the endpoint's breaker and the remote handler is never reached.
    if (method.schema) {
      const violation = validateIpcArgs(method.schema, args)
      if (violation) {
        throw new IPCSchemaError(targetPluginId, methodName, violation)
      }
    }

    // Bound the args with the same `maxMessageSize` cap that send/broadcast
    // enforce. call() is the primary RPC verb and previously bypassed the cap,
    // so an oversized payload could flood a remote handler. Runs before the
    // breaker (a bad-size call never charges the endpoint a failure).
    this.validateMessage(args)

    const breaker = this.getBreaker(targetPluginId, methodName)
    if (!breaker.canPass()) {
      throw new CircuitOpenError(targetPluginId, methodName)
    }

    // Pre-flight abort check — saves a handler invocation if the
    // caller already gave up before the call landed.
    if (options.signal?.aborted) {
      throw new IPCAbortError("aborted before dispatch")
    }

    this.log("call", { callerId, targetPluginId, methodName, args })

    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeout
    const label = `ipc.call:${targetPluginId}.${methodName}`

    const handlerPromise = (async () => {
      try {
        return (await method.handler(...args)) as T
      } catch (error) {
        throw new Error(
          `RPC call to ${targetPluginId}.${methodName} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    })()

    let abortListener: (() => void) | null = null
    const abortPromise = options.signal
      ? new Promise<never>((_, reject) => {
          abortListener = () => reject(new IPCAbortError())
          options.signal!.addEventListener("abort", abortListener, { once: true })
        })
      : null

    const raced = abortPromise
      ? Promise.race([withTimeout(handlerPromise, timeoutMs, label), abortPromise])
      : withTimeout(handlerPromise, timeoutMs, label)

    try {
      const result = await raced
      breaker.recordSuccess()
      this.maybeRecordBreakerTransition(targetPluginId, methodName, breaker)
      return result
    } catch (error) {
      if (error instanceof IPCAbortError) {
        // Aborts don't count as endpoint failures — the breaker stays
        // closed so other callers aren't penalised for one impatient
        // consumer.
        throw error
      }
      breaker.recordFailure()
      this.maybeRecordBreakerTransition(targetPluginId, methodName, breaker)
      throw error
    } finally {
      if (options.signal && abortListener) {
        options.signal.removeEventListener("abort", abortListener)
      }
    }
  }

  /**
   * Wake an idle-suspended target plugin so its exposed IPC methods are
   * re-registered before a cross-plugin RPC retries the lookup. Returns true
   * when a resume was attempted (the target was `suspended`), false otherwise.
   * Best-effort and lazy-imported: a missing/uninitialized manager or store
   * (web profile, early boot) resolves false so `call()` throws its normal
   * "no exposed methods" error. Only the miss path pays this cost — the common
   * case (method already exposed) never reaches here.
   */
  private async tryResumeSuspendedTarget(targetPluginId: string): Promise<boolean> {
    try {
      const { usePluginStore } = await import("@/stores/plugin-runtime")
      const status = usePluginStore.getState().plugins[targetPluginId]?.status
      if (status !== "suspended") return false
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().resumePlugin(targetPluginId, "ipc-call")
      return true
    } catch {
      return false
    }
  }

  private getBreaker(targetPluginId: string, methodName: string): CircuitBreaker {
    const key = `${targetPluginId}::${methodName}`
    let breaker = this.breakers.get(key)
    if (!breaker) {
      breaker = createCircuitBreaker()
      this.breakers.set(key, breaker)
      this.breakerStates.set(key, "closed")
    }
    return breaker
  }

  private maybeRecordBreakerTransition(
    targetPluginId: string,
    methodName: string,
    breaker: CircuitBreaker
  ): void {
    const key = `${targetPluginId}::${methodName}`
    const previous = this.breakerStates.get(key) ?? "closed"
    const current = breaker.state()
    if (previous === current) return
    this.breakerStates.set(key, current)
    if (previous === "closed" && current === "open") {
      const snapshot = breaker.snapshot()
      recordSilentFailure(
        targetPluginId,
        {
          site: "ipc.circuit-open",
          message: `IPC breaker opened for ${methodName} (failure rate ${snapshot.recentFailureRate.toFixed(0)}% over ${snapshot.eventCount} events)`,
          expected: false,
        },
        new CircuitOpenError(targetPluginId, methodName)
      )
    }
  }

  /**
   * Inspect the current breaker state for a `(pluginId, methodName)`
   * pair. Returns `null` when no breaker has been instantiated yet
   * (i.e., the endpoint hasn't been called).
   */
  getBreakerState(
    targetPluginId: string,
    methodName: string
  ): "closed" | "open" | "half_open" | null {
    const breaker = this.breakers.get(`${targetPluginId}::${methodName}`)
    return breaker ? breaker.state() : null
  }

  /**
   * Snapshot every instantiated breaker's state. Used by the messaging
   * diagnostics UI to surface degraded endpoints. Keyed by `(pluginId,
   * methodName)` — only endpoints that have actually been called appear.
   */
  getAllBreakerStates(): Array<{
    pluginId: string
    methodName: string
    state: "closed" | "open" | "half_open"
  }> {
    const result: Array<{
      pluginId: string
      methodName: string
      state: "closed" | "open" | "half_open"
    }> = []
    for (const [key, breaker] of this.breakers.entries()) {
      const [pluginId, methodName] = key.split("::")
      result.push({ pluginId, methodName, state: breaker.state() })
    }
    return result
  }

  getExposedMethods(pluginId: string): string[] {
    const methodMap = this.exposedMethods.get(pluginId)
    if (!methodMap) return []
    return Array.from(methodMap.keys())
  }

  getAllExposedMethods(): Map<string, string[]> {
    const result = new Map<string, string[]>()
    for (const [pluginId, methodMap] of this.exposedMethods.entries()) {
      result.set(pluginId, Array.from(methodMap.keys()))
    }
    return result
  }

  /**
   * Service discovery: describe a plugin's exposed methods (name + description
   * + arg schema), without leaking the handler functions. Powers both
   * `ctx.ipc.describeExposedMethods` and the messaging diagnostics UI.
   */
  describeExposedMethods(pluginId: string): IpcExposedMethodInfo[] {
    const methodMap = this.exposedMethods.get(pluginId)
    if (!methodMap) return []
    return Array.from(methodMap.values()).map((m) => ({
      name: m.name,
      description: m.description,
      schema: m.schema,
    }))
  }

  // ===========================================================================
  // Message Delivery
  // ===========================================================================

  private deliverMessage(message: IPCMessage): void {
    if (message.targetId) {
      // Direct message
      const subs = this.subscriptions.get(message.channel)
      if (subs) {
        for (const sub of subs) {
          if (sub.pluginId === message.targetId) {
            if (!sub.filter || sub.filter(message.senderId)) {
              try {
                sub.handler(message.payload, message.senderId)
              } catch (error) {
                loggers.manager.error(`[IPC] Delivery error to ${message.targetId}:`, error)
              }
            }
          }
        }
      }
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  private validateMessage(data: unknown): void {
    const serialized = JSON.stringify(data)
    const size =
      typeof Buffer !== "undefined"
        ? Buffer.byteLength(serialized, "utf8")
        : new Blob([serialized]).size
    if (size > this.config.maxMessageSize) {
      throw new Error(`Message size ${size} exceeds maximum ${this.config.maxMessageSize}`)
    }
  }

  private recordMessage(message: IPCMessage): void {
    this.messageHistory.push(message)
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory = this.messageHistory.slice(-this.maxHistory)
    }
  }

  private log(action: string, data: unknown): void {
    if (this.config.enableLogging) {
      loggers.manager.debug(`[IPC] ${action}:`, data)
    }
  }

  // ===========================================================================
  // Introspection
  // ===========================================================================

  getMessageHistory(options?: {
    channel?: string
    pluginId?: string
    limit?: number
  }): IPCMessage[] {
    let messages = [...this.messageHistory]

    if (options?.channel) {
      messages = messages.filter((m) => m.channel === options.channel)
    }

    if (options?.pluginId) {
      messages = messages.filter(
        (m) => m.senderId === options.pluginId || m.targetId === options.pluginId
      )
    }

    if (options?.limit) {
      messages = messages.slice(-options.limit)
    }

    return messages
  }

  getSubscriptions(pluginId?: string): Map<string, string[]> {
    const result = new Map<string, string[]>()

    for (const [channel, subs] of this.subscriptions.entries()) {
      const subscribers = Array.from(subs)
        .filter((s) => !pluginId || s.pluginId === pluginId)
        .map((s) => s.pluginId)

      if (subscribers.length > 0) {
        result.set(channel, subscribers)
      }
    }

    return result
  }

  getStats(): {
    totalSubscriptions: number
    totalExposedMethods: number
    messageCount: number
  } {
    let totalSubscriptions = 0
    for (const subs of this.subscriptions.values()) {
      totalSubscriptions += subs.size
    }

    let totalExposedMethods = 0
    for (const methods of this.exposedMethods.values()) {
      totalExposedMethods += methods.size
    }

    return {
      totalSubscriptions,
      totalExposedMethods,
      messageCount: this.messageHistory.length,
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  clear(): void {
    this.subscriptions.clear()
    this.exposedMethods.clear()
    this.messageHistory = []
    this.pluginPermissions.clear()
    this.breakers.clear()
    this.breakerStates.clear()
  }

  clearHistory(): void {
    this.messageHistory = []
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let ipcInstance: PluginIPC | null = null

export function getPluginIPC(config?: Partial<IPCConfig>): PluginIPC {
  if (!ipcInstance) {
    ipcInstance = new PluginIPC(config)
  }
  return ipcInstance
}

export function resetPluginIPC(): void {
  if (ipcInstance) {
    ipcInstance.clear()
    ipcInstance = null
  }
}

// =============================================================================
// Context API Factory
// =============================================================================

export function createIPCAPI(pluginId: string): PluginIPCAPI {
  const ipc = getPluginIPC()

  // Cross-plugin reach is permission-gated, mirroring how `agent:dispatch`
  // gates the agent fan-out surface. Outbound messaging (`send`/`sendAndWait`/
  // `broadcast`/`call`) requires `ipc:call`; publishing callable methods
  // requires `ipc:expose`. Receiving (`on`) and introspection
  // (`getExposedMethods`) stay ungated.
  const requirePerm = (permission: "ipc:call" | "ipc:expose", method: string): void => {
    if (!pluginHasApiPermission(pluginId, permission)) {
      throw new Error(
        `ipc.${method} requires the "${permission}" permission — declare it in the plugin manifest.`
      )
    }
  }

  return {
    // Async methods are written `async` so the gate surfaces as a rejected
    // promise (matching their `Promise` return type) rather than a synchronous
    // throw; `broadcast`/`expose` return void so they throw synchronously.
    send: async (targetPluginId, channel, data) => {
      requirePerm("ipc:call", "send")
      return ipc.send(pluginId, targetPluginId, channel, data)
    },
    broadcast: (channel, data) => {
      requirePerm("ipc:call", "broadcast")
      ipc.broadcast(pluginId, channel, data)
    },
    on: (channel, handler) => ipc.subscribe(pluginId, channel, handler),
    expose: (methods) => {
      requirePerm("ipc:expose", "expose")
      ipc.expose(pluginId, methods)
    },
    describeExposedMethods: (targetPluginId) => ipc.describeExposedMethods(targetPluginId),
    call: async <T>(
      targetPluginId: string,
      method: string,
      args: unknown[] = [],
      options?: PluginIPCCallOptions
    ) => {
      requirePerm("ipc:call", "call")
      return ipc.call<T>(pluginId, targetPluginId, method, args, options)
    },
    getExposedMethods: (targetPluginId) => ipc.getExposedMethods(targetPluginId),
  }
}
