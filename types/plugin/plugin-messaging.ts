/**
 * Plugin messaging type contracts — the inter-plugin communication surface.
 *
 * Source of truth for the two plugin-facing messaging APIs exposed on
 * `ctx.events`:
 *   - `ctx.events.ipc` ({@link PluginIPCAPI}) — directed / broadcast / RPC
 *     messaging between plugins (request-response, circuit-broken).
 *   - `ctx.events.bus` ({@link PluginEventAPI}) — the global pub/sub event bus
 *     (namespaced events, wildcard / regex subscriptions, replay).
 *
 * These live in `types/` (not `lib/plugin/messaging/*`) so `types/plugin/plugin.ts`
 * can declare them on `PluginEventEmitter` without a `types → lib` import edge.
 * The runtime classes in `lib/plugin/messaging/{ipc,message-bus}.ts` import and
 * re-export these, keeping one source of truth.
 */

// =============================================================================
// Event bus (ctx.events.bus)
// =============================================================================

export interface EventSource {
  type: "plugin" | "system" | "user"
  id: string
  name?: string
}

export interface BusEvent<T = unknown> {
  id: string
  type: string
  source: EventSource
  payload: T
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface EventFilter {
  sourceType?: "plugin" | "system" | "user"
  sourceId?: string
  metadata?: Record<string, unknown>
}

/** Plugin-scoped façade over the global {@link BusEvent} message bus. */
export interface PluginEventAPI {
  emit: <T>(eventType: string, payload: T, metadata?: Record<string, unknown>) => string
  on: <T>(
    eventType: string | RegExp,
    handler: (event: BusEvent<T>) => void,
    filter?: EventFilter
  ) => () => void
  once: <T>(
    eventType: string | RegExp,
    handler: (event: BusEvent<T>) => void,
    filter?: EventFilter
  ) => () => void
  off: (subscriptionId: string) => void
  offAll: () => void
  getHistory: (eventType?: string | RegExp, limit?: number) => BusEvent[]
}

// =============================================================================
// Inter-plugin IPC (ctx.events.ipc)
// =============================================================================

/**
 * Per-call cancellation / timeout knobs for {@link PluginIPCAPI.call}.
 */
export interface PluginIPCCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Lightweight, dependency-free schema describing the positional arguments of
 * an exposed RPC method. Validated at the `call()` boundary so a caller passing
 * the wrong arity / types fails fast with a typed error instead of crashing the
 * remote handler. Kept intentionally small (no JSON-Schema engine) so it works
 * inside the static-export bundle.
 */
export type IpcArgType = "string" | "number" | "boolean" | "object" | "array" | "unknown"

export interface IpcMethodArgSchema {
  type: IpcArgType
  /** When true, the argument (and any after it) may be omitted. */
  optional?: boolean
}

export interface IpcMethodSchema {
  /** Positional argument contract, in order. */
  args?: IpcMethodArgSchema[]
  description?: string
}

/** Handler plus optional discovery metadata + arg schema for an exposed method. */
export interface IpcExposedMethodDescriptor {
  handler: (...args: unknown[]) => unknown | Promise<unknown>
  schema?: IpcMethodSchema
  description?: string
  /**
   * Target-side ACL: plugin ids allowed to invoke this method. Omitted =
   * callable by any plugin (back-compat). The owner can always call its
   * own methods. Enumeration (`getExposedMethods`/`describeExposedMethods`)
   * only lists methods the asking plugin may call.
   */
  allowedCallers?: string[]
}

/** Either a bare handler (back-compat) or a descriptor with schema/description. */
export type IpcExposedMethods = Record<
  string,
  ((...args: unknown[]) => unknown | Promise<unknown>) | IpcExposedMethodDescriptor
>

/** Discovery view of an exposed method (no handler), for service discovery / UI. */
export interface IpcExposedMethodInfo {
  name: string
  description?: string
  schema?: IpcMethodSchema
}

/** Plugin-scoped façade over the inter-plugin IPC manager. */
export interface PluginIPCAPI {
  send: (targetPluginId: string, channel: string, data: unknown) => Promise<void>
  /**
   * Publish to every subscriber of `channel` (except the sender). Pass
   * `options.to` to restrict delivery to an explicit receiver allowlist —
   * without it any subscribed plugin receives the payload.
   */
  broadcast: (channel: string, data: unknown, options?: { to?: string[] }) => void
  on: (channel: string, handler: (data: unknown, senderId: string) => void) => () => void
  expose: (methods: IpcExposedMethods) => void
  call: <T>(
    targetPluginId: string,
    method: string,
    args?: unknown[],
    options?: PluginIPCCallOptions
  ) => Promise<T>
  getExposedMethods: (pluginId: string) => string[]
  /** Service discovery: describe another plugin's exposed methods (name + schema). */
  describeExposedMethods: (pluginId: string) => IpcExposedMethodInfo[]
}
