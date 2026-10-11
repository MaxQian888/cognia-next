"use client"

import { useEffect } from "react"

/**
 * Load the provider keys paired devices sealed on this desktop host
 * (ADR-0224 A6) into the provider-settings overlay, and follow changes.
 *
 * A desktop in always-on mode runs work moved to it from other devices, and
 * a provider key is a `desktop-only` setting that never syncs, so this
 * desktop may have none for a provider that work uses. Its own keys always
 * win: the overlay only fills providers with no key. Main window only (the
 * pet and overlay windows run no agent turns); the module is loaded lazily.
 */
export function HostProviderKeysInitializer() {
  useEffect(() => {
    let cancelled = false
    let stop: (() => void) | undefined

    void (async () => {
      const { defaultHostProviderKeyDeps, installHostProviderKeys } =
        await import("@/lib/host-secrets/provider-key-overlay")
      const deps = defaultHostProviderKeyDeps()
      if (!deps || cancelled) return
      stop = installHostProviderKeys(deps).stop
    })().catch(() => undefined)

    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  return null
}

export default HostProviderKeysInitializer
