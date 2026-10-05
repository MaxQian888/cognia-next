/**
 * Change feed over the external-agent configuration store (ADR-0216 §2).
 *
 * One diff, two consumers: `ctx.externalAgents.onChange` (TypeScript plugins,
 * a returned disposer the plugin scope releases on disable) and the
 * `onExternalAgentConfigChange` hook (every runtime, including Python, whose
 * plugins cannot hold a host-side callback across the stdio boundary).
 *
 * Events carry only a kind and an agent id. A listener that wants the new
 * state reads it back through the guarded API, so the secret-free projection
 * stays the only shape a plugin ever sees, and the feed itself can never
 * become a second, unprojected read path.
 */

import type { ExternalAgentStore } from "@/stores/agent/external-agent-store"

export type ExternalAgentChangeType =
  | "config-added"
  | "config-updated"
  | "config-removed"
  | "connection-changed"
  | "settings-changed"
  | "delegation-changed"

export interface ExternalAgentChangeEvent {
  type: ExternalAgentChangeType
  /** The configuration the change concerns; absent for settings and delegation changes. */
  agentId?: string
}

/** The slice of the store the diff reads. */
export type ExternalAgentChangeSnapshot = Pick<
  ExternalAgentStore,
  | "agents"
  | "connectionStatus"
  | "delegationRules"
  | "enabled"
  | "defaultPermissionMode"
  | "autoConnectOnStartup"
  | "showConnectionNotifications"
  | "chatFailurePolicy"
>

/** Global settings a plugin can read through `ctx.externalAgents.getSettings`. */
export const EXTERNAL_AGENT_SETTING_KEYS = [
  "enabled",
  "defaultPermissionMode",
  "autoConnectOnStartup",
  "showConnectionNotifications",
  "chatFailurePolicy",
] as const satisfies readonly (keyof ExternalAgentChangeSnapshot)[]

/**
 * What changed between two store states.
 *
 * Identity comparison is exact here, not approximate: the store replaces an
 * agent record (and the connection map, and the rule list) only when it
 * writes it, and `setConnectionStatus` is idempotent, so an unchanged record
 * keeps its identity and produces no event.
 */
export function diffExternalAgentState(
  previous: ExternalAgentChangeSnapshot,
  next: ExternalAgentChangeSnapshot
): ExternalAgentChangeEvent[] {
  const events: ExternalAgentChangeEvent[] = []

  if (previous.agents !== next.agents) {
    for (const [id, record] of Object.entries(next.agents)) {
      const before = previous.agents[id]
      if (!before) events.push({ type: "config-added", agentId: id })
      else if (before !== record) events.push({ type: "config-updated", agentId: id })
    }
    for (const id of Object.keys(previous.agents)) {
      if (!Object.hasOwn(next.agents, id)) events.push({ type: "config-removed", agentId: id })
    }
  }

  if (previous.connectionStatus !== next.connectionStatus) {
    const ids = new Set([
      ...Object.keys(previous.connectionStatus),
      ...Object.keys(next.connectionStatus),
    ])
    for (const id of ids) {
      // A status entry appearing with a new agent, or going away with a
      // removed one, is part of that add or removal, not a connection change.
      if (!Object.hasOwn(next.agents, id) || !Object.hasOwn(previous.agents, id)) continue
      if (previous.connectionStatus[id] !== next.connectionStatus[id]) {
        events.push({ type: "connection-changed", agentId: id })
      }
    }
  }

  if (EXTERNAL_AGENT_SETTING_KEYS.some((key) => previous[key] !== next[key])) {
    events.push({ type: "settings-changed" })
  }

  if (previous.delegationRules !== next.delegationRules) {
    events.push({ type: "delegation-changed" })
  }

  return events
}

type ChangeListener = (event: ExternalAgentChangeEvent) => void

/**
 * Subscribe to the store's change feed. Returns a disposer.
 *
 * The store module is loaded lazily so a plugin context that never asks about
 * external agents does not pull the store (and the manager graph behind its
 * actions) into its load. A disposer called before the load finishes cancels
 * the subscription it would have made.
 *
 * Listeners run in a microtask, outside the store's `set`: a listener that
 * reads the store back, or writes it through the lifecycle service, must not
 * re-enter the dispatch that is notifying it. One listener throwing never
 * stops the others; the error is handed to `onError`.
 */
export function subscribeExternalAgentChanges(
  listener: ChangeListener,
  onError: (error: unknown) => void = () => {}
): () => void {
  let disposed = false
  let unsubscribe: (() => void) | undefined

  void import("@/stores/agent/external-agent-store")
    .then(({ useExternalAgentStore }) => {
      if (disposed) return
      unsubscribe = useExternalAgentStore.subscribe((state, previous) => {
        if (disposed) return
        const events = diffExternalAgentState(previous, state)
        if (events.length === 0) return
        queueMicrotask(() => {
          for (const event of events) {
            if (disposed) return
            try {
              listener(event)
            } catch (error) {
              onError(error)
            }
          }
        })
      })
    })
    .catch(onError)

  return () => {
    disposed = true
    unsubscribe?.()
    unsubscribe = undefined
  }
}
