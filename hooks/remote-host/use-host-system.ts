"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { SystemDetails } from "@/lib/perf/backend/types"
import { readHostSystemDetails } from "@/lib/remote-host/host-system"

export interface UseHostSystemResult {
  /** Null until the first read lands. */
  details: SystemDetails | null
  /** Why the last read failed, if it did. */
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

/**
 * A Host's system details. Read on mount, on host change and when asked:
 * what they describe changes when the machine does, not while it runs, so
 * nothing polls them. Memory in use is a moment's reading and says so.
 */
export function useHostSystem(
  hostRef: string | null,
  load: (hostRef: string) => Promise<SystemDetails> = readHostSystemDetails
): UseHostSystemResult {
  const [details, setDetails] = useState<SystemDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Only the newest read may land: a slow read for the previous Host must not
  // overwrite the current one.
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const ticket = ++generation.current
    if (!hostRef) {
      setDetails(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await load(hostRef)
      if (ticket !== generation.current) return
      setDetails(next)
      setError(null)
    } catch (cause) {
      if (ticket !== generation.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [hostRef, load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read on mount; its results land after the await
    void reload()
  }, [reload])

  return { details, error, loading, reload }
}
