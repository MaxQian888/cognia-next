"use client"

// Keeps OAuth-issued provider credentials from going stale while the app runs.
//
// Every reader of a provider credential takes it straight off
// `providerSettings[id].apiKey`, in a dozen places across the chat, operations
// and embedding paths. Renewing the stored key here means all of them stay
// correct without any of them learning about expiry.
//
// The sweep is a no-op unless something is actually near expiry, and the
// credential ledger stops a provider that refused a renewal from being asked
// again on the next tick, so a revoked grant costs one request rather than one
// per sweep for as long as the app is open.

import { useEffect } from "react"

import { jitterCadenceMs } from "@/lib/subscription/retry/backoff"
import { refreshExpiringOAuthCredentials } from "@/lib/ai/providers/oauth-credential-refresh"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** How often to look for a credential worth renewing. */
export const PROVIDER_OAUTH_SWEEP_MS = 5 * 60_000

/** Spread, so several open windows do not sweep on the same tick. */
export const PROVIDER_OAUTH_SWEEP_JITTER = 0.2

/**
 * Delay before the first sweep.
 *
 * Two reasons, both about ordering rather than load. The proxy-fetch adapter
 * every provider-core call reads is installed by a sibling initializer in this
 * same commit, and a credential that expired while the app was closed should
 * be renewed well before the user's first turn rather than at the five minute
 * mark.
 */
export const PROVIDER_OAUTH_FIRST_SWEEP_MS = 3_000

export function ProviderOAuthRefreshInitializer() {
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const sweep = async () => {
      if (stopped) return
      try {
        await refreshExpiringOAuthCredentials({
          readSettings: () => useSettingsStore.getState().settings?.providerSettings,
          writeSettings: (providerId, patch) =>
            useSettingsStore.getState().updateProviderSettings(providerId, patch),
        })
      } catch {
        // A sweep is best effort. Its failure must not take down boot, and the
        // ledger has already recorded whatever went wrong per provider.
      } finally {
        if (!stopped) {
          timer = setTimeout(
            () => void sweep(),
            jitterCadenceMs(PROVIDER_OAUTH_SWEEP_MS, PROVIDER_OAUTH_SWEEP_JITTER)
          )
        }
      }
    }

    timer = setTimeout(() => void sweep(), PROVIDER_OAUTH_FIRST_SWEEP_MS)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return null
}

export default ProviderOAuthRefreshInitializer
