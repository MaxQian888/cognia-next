// Thin React hooks over the CCSwitch IPC client. Pattern: lazy fetch on
// mount, manual `refresh()` for invalidation, simple state — no SWR, no
// query cache. The CCSwitch DB is small enough that a per-tab refresh
// is fine and avoids pulling in a new dep.
//
// `refreshOnFocus` opts a hook into re-fetching when the browser tab /
// Tauri window regains focus — this is what `ccswitchSync.watchDb`
// drives, so the active-provider badges stay fresh even when the user
// switches providers in CCSwitch with cognia-next still open.

import { useCallback, useEffect, useRef, useState } from "react"

import {
  ccswitchListMcpServers,
  ccswitchListPrompts,
  ccswitchListProviders,
  ccswitchListSkills,
  ccswitchStatus,
  ccswitchWatchStart,
  ccswitchWatchStop,
} from "./client"
import { onTauriEvent } from "@/lib/tauri/events"
import { isTauri } from "@/lib/tauri"
import type {
  CcswitchMcpServer,
  CcswitchPrompt,
  CcswitchProvider,
  CcswitchSkill,
  CcswitchStatus,
} from "@/types/ccswitch"

/** Tauri event the cc-switch.db watcher emits on debounced db mutations. */
const DB_CHANGED_EVENT = "ccswitch://db-changed"

// Every hook shares the backend's single watcher. Serialize lifecycle calls so
// a late stop cannot tear down a new subscription during tab changes.
const watchUsers = new Map<symbol, string | undefined>()
let activeWatch: { manualDataDir?: string } | null = null
let watchOperation = Promise.resolve()
function syncWatch() {
  watchOperation = watchOperation
    .then(async () => {
      const desired = [...watchUsers.values()].at(-1)
      if (watchUsers.size === 0) {
        if (activeWatch) await ccswitchWatchStop()
        activeWatch = null
        return
      }
      if (activeWatch && activeWatch.manualDataDir === desired) return
      if (activeWatch) {
        await ccswitchWatchStop()
        activeWatch = null
      }
      if (await ccswitchWatchStart(desired)) activeWatch = { manualDataDir: desired }
    })
    .catch(() => {
      activeWatch = null
    })
}
function retainWatch(manualDataDir?: string): () => void {
  const user = Symbol()
  watchUsers.set(user, manualDataDir)
  syncWatch()
  return () => {
    watchUsers.delete(user)
    syncWatch()
  }
}

export interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: string | undefined
  refresh: () => Promise<void>
}

interface UseAsyncOptions {
  enabled?: boolean
  /**
   * Re-fetch when the window/tab regains focus AND when the backend emits
   * `ccswitch://db-changed` (live db watch). Off by default — gated by
   * `ccswitchSync.enabled && watchDb` at the call site.
   */
  refreshOnFocus?: boolean
  /**
   * Manual cc-switch data-dir override threaded into `ccswitchWatchStart` so
   * the live watcher watches the same db the fetchers read. The fetcher itself
   * is already bound to the override by the caller.
   */
  manualDataDir?: string
}

function useAsync<T>(fetcher: () => Promise<T>, options: UseAsyncOptions = {}): AsyncState<T> {
  const { enabled = true, refreshOnFocus = false, manualDataDir } = options
  const generation = useRef({ value: 0 })
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (!enabled) return
    const request = ++generation.current.value
    setLoading(true)
    setError(undefined)
    try {
      const v = await fetcher()
      if (request === generation.current.value) setData(v)
    } catch (e) {
      if (request === generation.current.value) {
        setData(undefined)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (request === generation.current.value) setLoading(false)
    }
  }, [fetcher, enabled])

  useEffect(() => {
    if (!enabled) return
    const sequence = generation.current
    // eslint-disable-next-line react-hooks/set-state-in-effect -- begin the asynchronous fetch when its source changes
    void refresh()
    return () => {
      sequence.value++
    }
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

  useEffect(() => {
    if (!enabled || !refreshOnFocus || !isTauri()) return
    let unlisten: (() => void) | undefined
    let release: (() => void) | undefined
    let cancelled = false
    void onTauriEvent(DB_CHANGED_EVENT, () => {
      void refresh()
    })
      .then((un) => {
        if (cancelled) {
          un()
          return
        }
        unlisten = un
        release = retainWatch(manualDataDir)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
      release?.()
    }
  }, [enabled, refreshOnFocus, refresh, manualDataDir])

  return { data, loading, error, refresh }
}

export function useCcswitchStatus(
  enabled: boolean = true,
  refreshOnFocus: boolean = false,
  manualDataDir?: string
): AsyncState<CcswitchStatus> {
  const fetcher = useCallback(() => ccswitchStatus(manualDataDir), [manualDataDir])
  return useAsync(fetcher, { enabled, refreshOnFocus, manualDataDir })
}

export function useCcswitchProviders(
  enabled: boolean = true,
  refreshOnFocus: boolean = false,
  manualDataDir?: string
): AsyncState<CcswitchProvider[]> {
  const fetcher = useCallback(() => ccswitchListProviders(manualDataDir), [manualDataDir])
  return useAsync(fetcher, { enabled, refreshOnFocus, manualDataDir })
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
