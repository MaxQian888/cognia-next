"use client"

import { useEffect, useState } from "react"

import type { ConnectionState, TransportTier } from "@/lib/tauri/transport-companion"

/** Tiers that carry RPCs and events without the WebSocket plane (ADR-0021, ADR-0170). */
const WAN_TIERS: ReadonlySet<TransportTier> = new Set(["relay", "rtc-direct", "rtc-relay"])

/**
 * The state to show for a raw `ConnectionState` and the transport's tier.
 *
 * `ConnectionState` describes the WebSocket events plane only. A phone that
 * cannot pin the Host's certificate never opens that socket and reaches the
 * Host over the relay or a DataChannel instead, so the raw state reads
 * `offline` on a link that is carrying every command. An open WAN tier is a
 * connection; a revoked device (`unauthenticated`) stays what it is.
 */
export function effectiveConnectionState(
  state: ConnectionState,
  tier: TransportTier | null
): ConnectionState {
  if ((state === "offline" || state === "reconnecting") && tier !== null && WAN_TIERS.has(tier)) {
    return "connected"
  }
  return state
}

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
 *
 * The answer folds in the transport tier (`effectiveConnectionState`): a link
 * carried by the relay or a DataChannel is `connected` even while the
 * WebSocket plane is closed.
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
      onTierChange?: (cb: (tier: TransportTier) => void) => () => void
    }) => {
      cleanup?.()
      cleanup = null
      if (typeof t.getConnectionState !== "function") {
        // The replacement may not speak connection state at all (the web stub).
        // Reporting the previous instance's last value would be a stale claim.
        setState(null)
        return
      }
      let raw = t.getConnectionState()
      let tier: TransportTier | null = null
      const publish = () => setState(effectiveConnectionState(raw, tier))
      publish()
      const detachState =
        typeof t.onConnectionStateChange === "function"
          ? t.onConnectionStateChange((next) => {
              raw = next
              publish()
            })
          : null
      // `onTierChange` seeds the listener with the current tier.
      const detachTier =
        typeof t.onTierChange === "function"
          ? t.onTierChange((next) => {
              tier = next
              publish()
            })
          : null
      cleanup = () => {
        detachState?.()
        detachTier?.()
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
