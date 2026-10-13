"use client"

import { useEffect } from "react"

/**
 * Follow which providers the `/pair` Host this app drives holds a sealed key
 * for (ADR-0224 A6), so the model picker lists them and a turn can name them
 * without a key of its own. Every shell: a phone and a paired browser drive a
 * Host as their only runtime, and a desktop can be switched to one. Reads
 * nothing while no `/pair` Host is driven; the module is loaded lazily.
 */
export function RemoteHostKeysInitializer() {
  useEffect(() => {
    let cancelled = false
    let stop: (() => void) | undefined

    void (async () => {
      const { followRemoteHostKeys } = await import("@/lib/host-secrets/remote-host-keys-follower")
      if (cancelled) return
      stop = followRemoteHostKeys().stop
    })().catch(() => undefined)

    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  return null
}

export default RemoteHostKeysInitializer
