"use client"

// Codex-only React hooks. Only `useCodexDiscovery` lives here — the generic
// credential/account lifecycle (load/refresh/signOut) is handled by the
// provider-agnostic `useAccounts("codex")` in `lib/subscription/core/hooks.ts`.

import { useCallback, useEffect, useState } from "react"

import { isTauri } from "@/lib/tauri"

import { discoverCodexAuth } from "./discovery"
import type { DiscoveredCodexAuth } from "./discovery"

export interface UseCodexDiscoveryResult {
  discovered: DiscoveredCodexAuth | null
  loading: boolean
  error: string | null
  /** Force a re-probe (e.g. after the user runs `codex login` in a terminal). */
  reload: () => Promise<void>
}

export function useCodexDiscovery(): UseCodexDiscoveryResult {
  const [discovered, setDiscovered] = useState<DiscoveredCodexAuth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setDiscovered(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const got = await discoverCodexAuth()
      setDiscovered(got)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDiscovered(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) {
          setDiscovered(null)
          setLoading(false)
        }
        return
      }
      try {
        const got = await discoverCodexAuth()
        if (alive) setDiscovered(got)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return { discovered, loading, error, reload }
}
