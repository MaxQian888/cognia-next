"use client"

/**
 * Reactive view over the persisted CompanionConfig (pairing JWT,
 * deviceId, baseUrl, serverFingerprint…). The historical pattern was a
 * one-shot `hydrateCompanionConfig()` call in `useEffect` — that leaves
 * the UI stale when the desktop revokes the pairing remotely or when
 * the user wipes the config from /pair → PairedStep.
 *
 * This hook re-hydrates whenever:
 *   • The CompanionTransport emits a connection-state change
 *     (`unauthenticated` is the canonical "your JWT was rejected" signal).
 *   • The app resumes to the foreground (`subscribeResume` — covers the
 *     "paired on another tab / window" case).
 *
 * Returns the resolved config plus convenience flags + a manual `reload`.
 */

import { useCallback, useEffect, useState } from "react"

import { subscribeResume } from "@/lib/capacitor/app"
import { transport } from "@/lib/tauri"
import {
  companionStorage,
  type CompanionConfig,
  type CompanionConfigStorage,
} from "@/lib/tauri/companion-storage"

export interface UseCompanionConfigResult {
  config: CompanionConfig | null
  paired: boolean
  /** First 8 chars of `deviceId` — handy for status rows. */
  shortDeviceId: string | null
  loading: boolean
  reload: () => Promise<void>
}

export interface UseCompanionConfigOptions {
  /** Override the storage backend (tests). */
  storage?: CompanionConfigStorage
}

export function useCompanionConfig(opts: UseCompanionConfigOptions = {}): UseCompanionConfigResult {
  const { storage } = opts
  const [config, setConfig] = useState<CompanionConfig | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const backend = storage ?? companionStorage()
    try {
      const next = await backend.load()
      setConfig(next)
    } finally {
      setLoading(false)
    }
  }, [storage])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await reload()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [reload])

  useEffect(() => {
    // Re-hydrate on connection-state change. The HTTPS / RTC transports
    // both flip to "unauthenticated" the moment the desktop returns 401,
    // which is the canonical signal that pairing was revoked.
    const candidate = transport as unknown as {
      onConnectionStateChange?: (h: (state: string) => void) => () => void
    }
    if (typeof candidate.onConnectionStateChange !== "function") return
    return candidate.onConnectionStateChange(() => {
      void reload()
    })
  }, [reload])

  useEffect(() => {
    // Re-hydrate on foreground resume so a pair/unpair in another tab or
    // on a freshly-installed Capacitor build picks up the latest state.
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void (async () => {
      const off = await subscribeResume(() => {
        if (cancelled) return
        void reload()
      })
      if (cancelled) {
        off()
        return
      }
      unsubscribe = off
    })()
    return () => {
      cancelled = true
      if (unsubscribe) unsubscribe()
    }
  }, [reload])

  const paired = config !== null && config.deviceJwt.length > 0
  const shortDeviceId = paired && config ? config.deviceId.slice(0, 8) : null

  return { config, paired, shortDeviceId, loading, reload }
}
