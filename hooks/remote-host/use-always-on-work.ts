"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { loadAlwaysOnWork, type AlwaysOnWork } from "@/lib/remote-host/migration/candidates"

export interface UseAlwaysOnWorkResult {
  /** Null until the first read lands. */
  work: AlwaysOnWork | null
  error: string | null
  /** Read again, e.g. after a move or take-back changed what runs where. */
  reload: () => Promise<void>
}

/**
 * What this device runs, what one host runs for it, and which operations with
 * that host stopped short (ADR-0224). Read on mount, on host change, when the
 * window regains focus, and whenever the panel acts; never polled.
 */
export function useAlwaysOnWork(
  hostId: string | null,
  deps: { load?: (hostId: string) => Promise<AlwaysOnWork> } = {}
): UseAlwaysOnWorkResult {
  const load = deps.load ?? loadAlwaysOnWork
  const [work, setWork] = useState<AlwaysOnWork | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the newest read may land: a slow read for the previous host must not
  // overwrite the current one.
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const ticket = ++generation.current
    if (!hostId) {
      setWork(null)
      return
    }
    try {
      const next = await load(hostId)
      if (ticket !== generation.current) return
      setWork(next)
      setError(null)
    } catch (cause) {
      if (ticket !== generation.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [hostId, load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read on mount; its results land after the await
    void reload()
    const onFocus = () => void reload()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [reload])

  return { work, error, reload }
}
