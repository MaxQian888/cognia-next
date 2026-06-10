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
 * Per-call cancellation / timeout knobs for {@link PluginIPCAPI.call} and
 * {@link PluginIPCAPI.sendAndWait}.
 */
export interface PluginIPCCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/** Plugin-scoped façade over the inter-plugin IPC manager. */
export interface PluginIPCAPI {
  send: (targetPluginId: string, channel: string, data: unknown) => Promise<void>
  sendAndWait: <T>(
    targetPluginId: string,
    channel: string,
    data: unknown,
    options?: PluginIPCCallOptions | number
  ) => Promise<T>
  broadcast: (channel: string, data: unknown) => void
  on: (channel: string, handler: (data: unknown, senderId: string) => void) => () => void
  expose: (methods: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>) => void
  call: <T>(
    targetPluginId: string,
    method: string,
    args?: unknown[],
    options?: PluginIPCCallOptions
  ) => Promise<T>
  getExposedMethods: (pluginId: string) => string[]
}
