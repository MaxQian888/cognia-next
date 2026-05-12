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
 */
export function useConnectionState(): ConnectionState | null {
  const [state, setState] = useState<ConnectionState | null>(null)

  useEffect(() => {
    let cleanup: (() => void) | null = null
    let cancelled = false

    void (async () => {
      try {
        const mod = await import("@/lib/tauri/transport-instance")
        const t = mod.transport as unknown as {
          getConnectionState?: () => ConnectionState
          onConnectionStateChange?: (cb: (s: ConnectionState) => void) => () => void
        }
        if (cancelled) return
        if (typeof t.getConnectionState === "function") {
          setState(t.getConnectionState())
        }
        if (typeof t.onConnectionStateChange === "function") {
          cleanup = t.onConnectionStateChange(setState)
        }
      } catch {
        // Transport unavailable — leave the state as null so the UI can
        // render a neutral fallback.
      }
    })()

    return () => {
      cancelled = true
      if (cleanup) cleanup()
    }
  }, [])

  return state
}
