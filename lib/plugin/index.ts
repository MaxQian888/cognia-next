/**
 * Minimal plugin runtime stub.
 *
 * Cognia ships a plugin SDK that registers extra agent capabilities;
 * cognia-next has no plugin runtime yet. The hook-side imports of
 * `@/lib/plugin` only need a `pluginManager` shape that returns empty
 * collections, so we expose that.
 */

export interface PluginInfo {
  id: string
  name: string
  version?: string
}

interface PluginManager {
  list(): PluginInfo[]
  get(id: string): PluginInfo | undefined
}

export const pluginManager: PluginManager = {
  list: () => [],
  get: () => undefined,
}

/**
 * Stub for the plugin event-hook collector. Cognia plugins can register
 * before/after hooks for agent events; cognia-next has no plugin runtime
 * yet so every dispatcher is a no-op.
 *
 * The hook surface mirrors the upstream `useExternalAgent` consumer's
 * expectations — adding a method here is harmless when nobody listens.
 */
export interface PluginEventHooks {
  beforeSend?: Array<(payload: unknown) => unknown>
  afterReceive?: Array<(payload: unknown) => unknown>
  onError?: Array<(error: unknown) => void>
  // External-agent lifecycle dispatchers (no-ops in this build). Accept
  // varargs so plugin-shaped callers can pass any combination of payloads
  // without us tracking the exact signature for each event.
  dispatchExternalAgentConnect: (...args: unknown[]) => void
  dispatchExternalAgentDisconnect: (...args: unknown[]) => void
  dispatchExternalAgentError: (...args: unknown[]) => void
  dispatchExternalAgentExecutionStart: (...args: unknown[]) => void
  dispatchExternalAgentExecutionComplete: (...args: unknown[]) => void
}

export function getPluginEventHooks(): PluginEventHooks {
  const noop = () => undefined
  return {
    beforeSend: [],
    afterReceive: [],
    onError: [],
    dispatchExternalAgentConnect: noop,
    dispatchExternalAgentDisconnect: noop,
    dispatchExternalAgentError: noop,
    dispatchExternalAgentExecutionStart: noop,
    dispatchExternalAgentExecutionComplete: noop,
  }
}
