"use client"

// Starts the background Anthropic usage-probe loop on app boot (desktop only).
//
// Codex got `codex-usage-scheduler-initializer`; Anthropic never got its
// counterpart, so `startUsageScheduler` had zero call sites outside its own
// test. The Subscription → Probes panel wrote `subscriptionSettings.{
// probeEnabled, visibleIntervalMs, idleIntervalMs }` to the store and nothing
// ever read them: the switch and both cadence inputs were decoration. This is
// the wiring that makes them mean something.
//
// The scheduler reads the live settings each tick (via
// `useSettingsStore.getState()`, so cadence/enabled edits take effect without a
// restart) and self-gates on `probeEnabled`, so mounting unconditionally is
// safe — the loop is a no-op until the user opts in.

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { getAccount, getActiveAccount } from "@/lib/subscription/core/transport"
import { refreshAndPersistAnthropicAccount } from "@/lib/subscription/anthropic/refresh"
import { startUsageScheduler } from "@/lib/subscription/anthropic/scheduler"
import { isLimitsQueryEnabled } from "@/lib/subscription/limits/policy"
import {
  DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS,
  type AnthropicCredentialData,
  type AnthropicSubscriptionSettings,
} from "@/types/subscription"
import { useSettingsStore } from "@/stores/settings/settings-store"

function resolveSettings(
  app: { subscriptionSettings?: AnthropicSubscriptionSettings } | null | undefined
): AnthropicSubscriptionSettings {
  return app?.subscriptionSettings ?? DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS
}

/**
 * The active Anthropic account id, or null when there is none or the user has
 * opted this account out of quota queries. Same per-account opt-in the Codex
 * scheduler honours — probing is an outbound call the user can decline.
 */
async function resolveProbableAccountId(): Promise<string | null> {
  try {
    const active = await getActiveAccount("anthropic")
    const accountId = active.activeAccountId ?? null
    if (!accountId) return null
    const enabledAccounts = useSettingsStore.getState().settings?.limitsQueryEnabledAccounts
    return isLimitsQueryEnabled(enabledAccounts, "anthropic", accountId) ? accountId : null
  } catch {
    return null
  }
}

export function AnthropicUsageSchedulerInitializer() {
  useEffect(() => {
    if (!isTauri()) return
    const handle = startUsageScheduler(
      () => resolveSettings(useSettingsStore.getState().settings),
      {
        getCredential: async (): Promise<AnthropicCredentialData | null> => {
          const accountId = await resolveProbableAccountId()
          if (!accountId) return null
          try {
            const account = await getAccount("anthropic", accountId)
            if (!account || account.credential.provider !== "anthropic") return null
            return account.credential
          } catch {
            return null
          }
        },
        refresh: async () => {
          const accountId = await resolveProbableAccountId()
          if (!accountId) return null
          try {
            // `reactivate: false` — a background probe must never flip the
            // active pointer or restart the sidecar mid-chat.
            return await refreshAndPersistAnthropicAccount(accountId, { reactivate: false })
          } catch {
            return null
          }
        },
      }
    )
    return () => handle.stop()
  }, [])

  return null
}

export default AnthropicUsageSchedulerInitializer
