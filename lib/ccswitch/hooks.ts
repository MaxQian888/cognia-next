// Thin React hooks over the CCSwitch IPC client. Pattern: lazy fetch on
// mount, manual `refresh()` for invalidation, simple state — no SWR, no
// query cache. The CCSwitch DB is small enough that a per-tab refresh
// is fine and avoids pulling in a new dep.
//
// `refreshOnFocus` opts a hook into re-fetching when the browser tab /
// Tauri window regains focus — this is what `ccswitchSync.watchDb`
// drives, so the active-provider badges stay fresh even when the user
// switches providers in CCSwitch with cognia-next still open.

import { useCallback, useEffect, useState } from "react"

import {
  ccswitchListMcpServers,
  ccswitchListPrompts,
  ccswitchListProviders,
  ccswitchListSkills,
  ccswitchStatus,
} from "./client"
import type {
  CcswitchMcpServer,
  CcswitchPrompt,
  CcswitchProvider,
  CcswitchSkill,
  CcswitchStatus,
} from "@/types/ccswitch"

export interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: string | undefined
  refresh: () => Promise<void>
}

interface UseAsyncOptions {
  enabled?: boolean
  /** Re-fetch when the window/tab regains focus. Off by default. */
  refreshOnFocus?: boolean
}

function useAsync<T>(fetcher: () => Promise<T>, options: UseAsyncOptions = {}): AsyncState<T> {
  const { enabled = true, refreshOnFocus = false } = options
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError(undefined)
    try {
      const v = await fetcher()
      setData(v)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [fetcher, enabled])

  useEffect(() => {
    if (!enabled) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch on mount; setState is inside `refresh()`'s catch path
    void refresh()
  }, [refresh, enabled])

  useEffect(() => {
    if (!enabled || !refreshOnFocus) return
    if (typeof window === "undefined") return
    const onFocus = () => {
      void refresh()
    }
    const onVisibility = () => {
      if (!document.hidden) onFocus()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [enabled, refreshOnFocus, refresh])

  return { data, loading, error, refresh }
}

export function useCcswitchStatus(
  enabled: boolean = true,
  refreshOnFocus: boolean = false
): AsyncState<CcswitchStatus> {
  return useAsync(ccswitchStatus, { enabled, refreshOnFocus })
}

export function useCcswitchProviders(
  enabled: boolean = true,
  refreshOnFocus: boolean = false
): AsyncState<CcswitchProvider[]> {
  return useAsync(ccswitchListProviders, { enabled, refreshOnFocus })
}

export function useCcswitchMcpServers(enabled: boolean = true): AsyncState<CcswitchMcpServer[]> {
  return useAsync(ccswitchListMcpServers, { enabled })
}

export function useCcswitchPrompts(enabled: boolean = true): AsyncState<CcswitchPrompt[]> {
  return useAsync(ccswitchListPrompts, { enabled })
}

export function useCcswitchSkills(enabled: boolean = true): AsyncState<CcswitchSkill[]> {
  return useAsync(ccswitchListSkills, { enabled })
}
