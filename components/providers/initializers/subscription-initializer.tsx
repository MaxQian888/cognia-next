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

import { deferUntilSecretStoreReady } from "@/lib/credentials/secret-store-readiness"
import { subscriptionInitOnce } from "@/lib/subscription/core/migration"
import { notifySubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { maybeAutoUploadSubscription } from "@/lib/subscription/sync/subscription-sync"
import { useAccountStore } from "@/stores/account/account-store"

export function SubscriptionInitializer() {
  const lastInitializedKey = useRef<string | null>(null)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const accountRevision = useAccountStore((state) => state.accountRevision)
  // Bind the translator once per render; the callback inside subscriptionInitOnce
  // closes over it.
  const t = useTranslations("subscription.migration")

  useEffect(() => {
    if (!unlockedAccountId) return
    const initKey = `${unlockedAccountId}:${accountRevision}`
    if (lastInitializedKey.current === initKey) return
    lastInitializedKey.current = initKey

    const run = async (): Promise<void> => {
      const result = await subscriptionInitOnce({
        translateToast: (key, params) => t(key, params as Parameters<typeof t>[1]),
      })
      // A locked secret store is not a finished boot: run the whole init again
      // once the user unlocks it, unless the account has changed since.
      if (result.secretStoreUnavailable) {
        deferUntilSecretStoreReady("subscription.init", async () => {
          if (lastInitializedKey.current === initKey) await run()
        })
      }
      // The boot rebuild (subscription_init → apply_active_projection) may have
      // just pushed the OAuth bearer into ApiKeyState. Tell the chat header so
      // it drops the stale "No API key" badge without waiting for the user to
      // poke the settings popover. This also re-fires every limits refresh.
      notifySubscriptionChanged()
      await maybeAutoUploadSubscription().catch(() => undefined)
    }
    void run()
  }, [accountRevision, t, unlockedAccountId])

  return null
}

export default SubscriptionInitializer
