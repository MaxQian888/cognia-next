"use client"

/**
 * Reactive network-status hook (Wave 3.5).
 *
 * Wraps `lib/capacitor/network.subscribe` so React components can render
 * the offline banner / queue indicator without re-implementing the
 * subscribe + cleanup dance. Returns the latest status plus a `loading`
 * flag for the brief moment between mount and the first reading.
 *
 * On non-mobile platforms the hook still works — `subscribe` falls back
 * to `window.online` / `offline` events (see `lib/capacitor/network.ts`).
 */

import { useEffect, useState } from "react"

import {
  getStatus as getNetworkStatus,
  subscribe as subscribeNetwork,
  type NetworkStatus,
} from "@/lib/capacitor/network"

export interface UseNetworkStatusResult {
  loading: boolean
  status: NetworkStatus
}

const INITIAL: NetworkStatus = { connected: true, connectionType: "unknown" }

export function useNetworkStatus(): UseNetworkStatusResult {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<NetworkStatus>(INITIAL)

  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | null = null

    void (async () => {
      const initial = await getNetworkStatus()
      if (!cancelled && (initial.kind === "ok" || initial.kind === "fallback")) {
        setStatus(initial.status)
      }
      if (!cancelled) setLoading(false)
      unsub = await subscribeNetwork((next) => {
        setStatus(next)
      })
      // Unmounted while the subscribe was in flight — the cleanup below has
      // already run with `unsub === null`, so drop the listener here.
      if (cancelled) {
        try {
          unsub()
        } catch {
          // Best effort.
        }
      }
    })()

    return () => {
      cancelled = true
      if (unsub) {
        try {
          unsub()
        } catch {
          // Best effort.
        }
      }
    }
  }, [])

  return { loading, status }
}
