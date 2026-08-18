"use client"

/**
 * React binding for {@link resolveInboxWriteRoute} (ADR-0131). Re-renders on
 * every input the route depends on: the active remote transport (desktop
 * driving a remote host), the runtime snapshot (companion target + host
 * manifest), and the remote-host store (feature manifest readiness).
 */

import { useCallback, useSyncExternalStore } from "react"

import { subscribeRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import {
  hostSupportsInboxRelay,
  resolveInboxWriteAvailability,
  resolveInboxWriteRoute,
  type InboxWriteCommand,
  type InboxWriteRoute,
} from "./route"

function subscribeRouteInputs(onChange: () => void): () => void {
  const unsubscribeRemote = subscribeActiveRemoteTransport(onChange)
  const unsubscribeSnapshot = subscribeRuntimeSnapshot(onChange)
  const unsubscribeStore = useRemoteHostStore.subscribe(onChange)
  return () => {
    unsubscribeRemote()
    unsubscribeSnapshot()
    unsubscribeStore()
  }
}

/** Static-export / SSR snapshot: no shell globals yet → nothing is writable. */
const getServerRoute = (): InboxWriteRoute => "unavailable"

export function useInboxWriteRoute(): InboxWriteRoute {
  return useSyncExternalStore(subscribeRouteInputs, resolveInboxWriteRoute, getServerRoute)
}

export interface InboxWriteReadiness {
  route: InboxWriteRoute
  /** The host this shell relays to ships the relay feature (always `true` for `"local"`). */
  hostSupported: boolean
  /** Availability of the manual-reply command on the current route. */
  availability: ReturnType<typeof resolveInboxWriteAvailability>
}

/**
 * Route + host-support + per-command availability in one subscription. The
 * composer uses it to disable Send with an i18n reason; the inbox shell uses
 * it to render `StateCard.RequiresHost`.
 */
export function useInboxWriteReadiness(
  command: InboxWriteCommand = "connector_enqueue_outbound"
): InboxWriteReadiness {
  const getSnapshot = useCallback((): string => {
    const route = resolveInboxWriteRoute()
    const hostSupported = hostSupportsInboxRelay()
    const availability = resolveInboxWriteAvailability(command)
    // Serialise so `useSyncExternalStore` compares by value, not identity.
    return JSON.stringify({ route, hostSupported, availability })
  }, [command])
  const getServerSnapshot = useCallback(
    (): string =>
      JSON.stringify({
        route: "unavailable",
        hostSupported: false,
        availability: { state: "unsupported", reason: "requires-companion" },
      } satisfies InboxWriteReadiness),
    []
  )
  const serialised = useSyncExternalStore(subscribeRouteInputs, getSnapshot, getServerSnapshot)
  return JSON.parse(serialised) as InboxWriteReadiness
}
