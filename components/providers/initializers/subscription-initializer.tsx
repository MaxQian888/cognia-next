"use client"

// Fires once on app boot. Calls into the Rust `subscription_init` command,
// which detects any v1 keyring entries (from the pre-ADR-0025 single-account
// schema) and silently wraps them as "Default" accounts in the new v2 vault.
// A single Sonner toast notifies the user when an actual migration happened;
// the toast key is keyed by localStorage so it only ever fires once per
// profile, regardless of how many app boots follow.
//
// Also hydrates the subscription cloud-sync passphrase (opt-in keyring copy)
// and pokes the unattended uploader once — covering changes whose debounce
// was lost to an app exit. All gating lives inside
// `maybeAutoUploadSubscription`; this is a no-op when the toggle is off.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { subscriptionInitOnce } from "@/lib/subscription/core/migration"
import { maybeAutoUploadSubscription } from "@/lib/subscription/sync/subscription-sync"

export function SubscriptionInitializer() {
  const hasInitialized = useRef(false)
  // Bind the translator once per render; the callback inside subscriptionInitOnce
  // closes over it.
  const t = useTranslations("subscription.migration")

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    void (async () => {
      await subscriptionInitOnce({
        translateToast: (key, params) => t(key, params as Parameters<typeof t>[1]),
      })
      await maybeAutoUploadSubscription().catch(() => undefined)
    })()
  }, [t])

  return null
}

export default SubscriptionInitializer
