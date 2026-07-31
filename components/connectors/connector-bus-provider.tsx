"use client"

/**
 * ConnectorBusProvider — Task 41 + im-refactored-crayon.
 *
 * Thin React host for the shared connector bootstrap. The whole boot
 * sequence (scheduler executors → WS reap → adapter boot loop → runtime
 * route handler behind the PII gate → outbound runner → sweeps) lives in
 * `lib/connectors/bootstrap/install-connector-runtime.ts` so the headless
 * brain can run the identical code (ADR-0059 T-A5); this component only
 * binds it to the React lifecycle.
 *
 * No-op in web mode (the installer's default host gate is `isTauri()`).
 *
 * Deferred while driving a REMOTE Cognia host: when `isRemoteHostActive()`
 * (ADR-0082) the paired host's brain owns the connector runtime, so booting a
 * second copy here would double-dial the same bots — duplicate inbound events
 * AND duplicate outbound replies on the same account. We tear the local
 * runtime down when a remote host is activated and reclaim it when routing
 * returns to local. (`installConnectorRuntime`'s own Web Locks guard only
 * coordinates this desktop's webviews; it cannot see the remote process.)
 */

import { useEffect } from "react"
import { installConnectorRuntime } from "@/lib/connectors/bootstrap/install-connector-runtime"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

export function ConnectorBusProvider({ children }: { children?: React.ReactNode }) {
  useEffect(() => {
    let dispose: (() => void) | undefined
    // Own the local runtime only while routing locally; defer to the remote
    // brain otherwise. Re-evaluated on every active-host switch.
    const sync = () => {
      if (isRemoteHostActive()) {
        dispose?.()
        dispose = undefined
      } else {
        dispose ??= installConnectorRuntime()
      }
    }
    sync()
    const unsubscribe = subscribeActiveRemoteTransport(sync)
    return () => {
      unsubscribe()
      dispose?.()
    }
  }, [])

  return <>{children}</>
}
