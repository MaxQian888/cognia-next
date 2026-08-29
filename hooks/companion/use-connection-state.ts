"use client"

import { useEffect, useState } from "react"

import type { ConnectionState } from "@/lib/tauri/transport-companion"

/**
 * Phase C1 — subscribe to the companion transport's connection state.
 *
 * Returns the current `ConnectionState` (`connected` | `reconnecting` |
 * `offline` | `unauthenticated`) and re-renders on every transition.
 * Returns `null` when running on a transport that doesn't expose
 * connection-state semantics (Tauri desktop, plain web stub).
 *
 * The hook discovers the singleton via lazy import to keep the
 * non-Capacitor builds free of the companion-transport bundle weight.
 *
 * It also re-binds whenever the singleton is *replaced*
 * (`onTransportChange`). Subscribing once at mount was wrong in exactly the
 * case this hook exists for: a browser boots on the web stub, pairing swaps in
 * a real `CompanionTransport`, and `setTransport` destroys the stub — whose
 * teardown broadcasts `offline`. The hook was then pinned to a destroyed
 * instance and reported "Offline" for the rest of the session, while the live
 * transport had a working RPC plane and an open event socket.
 */
export function useConnectionState(): ConnectionState | null {
  const [state, setState] = useState<ConnectionState | null>(null)

  useEffect(() => {
    let cleanup: (() => void) | null = null
    let unwatchSwap: (() => void) | null = null
    let cancelled = false

    const bind = (t: {
      getConnectionState?: () => ConnectionState
      onConnectionStateChange?: (cb: (s: ConnectionState) => void) => () => void
    }) => {
      cleanup?.()
      cleanup = null
      if (typeof t.getConnectionState === "function") {
        setState(t.getConnectionState())
      } else {
        // The replacement may not speak connection state at all (the web stub).
        // Reporting the previous instance's last value would be a stale claim.
        setState(null)
      }
      if (typeof t.onConnectionStateChange === "function") {
        cleanup = t.onConnectionStateChange(setState)
      }
    }

    void (async () => {
      try {
        const mod = await import("@/lib/tauri/transport-instance")
        if (cancelled) return
        bind(mod.transport as Parameters<typeof bind>[0])
        unwatchSwap = mod.onTransportChange(() => {
          if (cancelled) return
          bind(mod.transport as Parameters<typeof bind>[0])
        })
      } catch {
        // Transport unavailable — leave the state as null so the UI can
        // render a neutral fallback.
      }
    })()

    return () => {
      cancelled = true
      unwatchSwap?.()
      cleanup?.()
    }
  }, [])

  return state
}
