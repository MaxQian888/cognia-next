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
  // Artifact lifecycle dispatchers (no-ops in this build). Plugins in
  // upstream Cognia subscribe to these to react to artifact creation,
  // edits, deletes, and panel open/close.
  dispatchArtifactCreate: (...args: unknown[]) => void
  dispatchArtifactUpdate: (...args: unknown[]) => void
  dispatchArtifactDelete: (...args: unknown[]) => void
  dispatchArtifactOpen: (...args: unknown[]) => void
  dispatchArtifactClose: (...args: unknown[]) => void
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
    dispatchArtifactCreate: noop,
    dispatchArtifactUpdate: noop,
    dispatchArtifactDelete: noop,
    dispatchArtifactOpen: noop,
    dispatchArtifactClose: noop,
  }
}

/**
 * Scheduler-side lifecycle dispatchers. Cognia plugins subscribe to these to
 * react to scheduled task start/complete/error events. cognia-next has no
 * runtime registry yet, so every dispatch is a no-op.
 */
export interface PluginLifecycleHooks {
  dispatchOnScheduledTaskStart: (taskId: string, executionId: string) => void
  dispatchOnScheduledTaskComplete: (
    taskId: string,
    executionId: string,
    result: { success: boolean; output?: unknown }
  ) => void
  dispatchOnScheduledTaskError: (taskId: string, executionId: string, error: Error) => void
}

export function getPluginLifecycleHooks(): PluginLifecycleHooks {
  const noop = () => undefined
  return {
    dispatchOnScheduledTaskStart: noop,
    dispatchOnScheduledTaskComplete: noop,
    dispatchOnScheduledTaskError: noop,
  }
}
