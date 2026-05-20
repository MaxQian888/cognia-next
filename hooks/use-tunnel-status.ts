"use client"

/**
 * Cross-surface tunnel status hook.
 *
 * Wraps `lib/connectivity/tunnel-resolver.getTunnelInfo()` with a small
 * polling loop so any settings card can subscribe to "is the Cloudflared
 * tunnel up, and at what public URL". Used by the Lark form's Delivery
 * section to auto-fill the webhook callback URL — and any other adapter
 * form that needs a publicly-reachable HTTPS endpoint.
 *
 * Mirrors the polling cadence used by TunnelCard in the companion section
 * (one fetch on mount + every 3 s while mounted). Failures are silently
 * coerced to "tunnel off" so consumers never need a try / catch.
 */

import { useEffect, useState } from "react"
import { getTunnelInfo, type TunnelInfo } from "@/lib/connectivity/tunnel-resolver"

const POLL_INTERVAL_MS = 3_000

export interface TunnelStatus {
  /** True when Cloudflared (or another tunnel) is currently running. */
  running: boolean
  /** Public HTTPS URL (no trailing slash) — `null` when not running. */
  url: string | null
  /** True until the first probe resolves; lets cards render a skeleton. */
  loading: boolean
}

/**
 * `loader` is exposed for tests so we can inject a deterministic
 * `getTunnelInfo` stand-in without touching the real Tauri bridge.
 */
export function useTunnelStatus(
  loader: () => Promise<TunnelInfo | null> = getTunnelInfo
): TunnelStatus {
  const [status, setStatus] = useState<TunnelStatus>({
    running: false,
    url: null,
    loading: true,
  })

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const refresh = async () => {
      try {
        const info = await loader()
        if (!cancelled) {
          setStatus({
            running: info !== null,
            url: info?.publicUrl ?? null,
            loading: false,
          })
        }
      } catch {
        if (!cancelled) {
          setStatus({ running: false, url: null, loading: false })
        }
      }
      if (!cancelled) timer = setTimeout(refresh, POLL_INTERVAL_MS)
    }

    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [loader])

  return status
}
