"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { listHostSecrets, type HostSecretEntry } from "@/lib/remote-host/host-secrets"

export interface UseHostSecretsResult {
  /** Null until the first read lands, and while reading is off. */
  entries: HostSecretEntry[] | null
  error: string | null
  /** Read again, e.g. after a key was sealed or removed. */
  reload: () => Promise<void>
}

/**
 * The secrets one host keeps, by name (ADR-0224 A6). Read on mount, on host
 * change and after the panel writes; never polled, because the list only
 * changes when someone acts. `enabled: false` (a host too old to answer)
 * reads nothing.
 */
export function useHostSecrets(
  hostId: string | null,
  options: { enabled?: boolean; load?: (hostId: string) => Promise<HostSecretEntry[]> } = {}
): UseHostSecretsResult {
  const load = options.load ?? listHostSecrets
  const enabled = options.enabled ?? true
  const [entries, setEntries] = useState<HostSecretEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the newest read may land: a slow read for the previous host must not
  // overwrite the current one.
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const ticket = ++generation.current
    if (!hostId || !enabled) {
      setEntries(null)
      return
    }
    try {
      const next = await load(hostId)
      if (ticket !== generation.current) return
      setEntries(next)
      setError(null)
    } catch (cause) {
      if (ticket !== generation.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [enabled, hostId, load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read on mount; its results land after the await
    void reload()
  }, [reload])

  return { entries, error, reload }
}
