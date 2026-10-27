"use client"

// Reactive credential presence for a selected provider/account. An omitted
// target retains the app-level Claude probe used by onboarding.
//
// Replaces the chat header's old one-shot `[open]` effect, which latched a
// stale "No API key" badge: a subscription-reuse user's OAuth bearer is pushed
// into the in-process `ApiKeyState` *after* boot (by `subscription_init` once a
// local profile unlocks, or by `subscription_set_active` when the user activates
// an account), but the header only re-checked when the settings popover toggled.
//
// This hook re-reads on three triggers so the badge tracks the real state:
//   1. mount,
//   2. the unlocked local account changing (`subscription_init` runs right
//      after unlock — see SubscriptionInitializer),
//   3. a `notifySubscriptionChanged()` broadcast (boot rebuild finished, or the
//      user activated / signed out of an account).
//
// `keyOk` is `true` when EITHER a direct Anthropic API key OR a subscription
// OAuth bearer is present (ADR-0025). `plan` carries the active Anthropic
// subscription tier ("pro" | "max" | "team" | "console" | …) so the header can
// show the tier instead of nothing — only populated when auth flows through the
// OAuth bearer (i.e. a real subscription, not a bare API key).

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { isTauri } from "@/lib/tauri"
import { hasApiKey, hasOauthBearer } from "@/lib/claude/ipc"
import { getAccount, getAccountDetail, getActiveAccount } from "@/lib/subscription/core/transport"
import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { loggers } from "@cognia/logging"
import { getAllProviders } from "@cognia/provider-types/provider"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { hostProviderKey } from "@/lib/host-secrets/provider-key-store"
import { resolveAccountId } from "@/lib/claude/env-resolver"
import { ccswitchApiKeyEnv } from "@/lib/ccswitch/provider"
import {
  remoteHostKeyedProviders,
  subscribeRemoteHostKeyedProviders,
} from "@/lib/host-secrets/remote-host-keys"

export interface CredentialTarget {
  /** Null: credentials belong to an Agent/Host that this client cannot probe. */
  providerId?: string | null
  accountId?: string | null
  /** Gateway tickets cannot reuse the desktop's Anthropic OAuth bearer. */
  gateway?: boolean
}

export interface CredentialStatus {
  /** `null` until the first probe resolves; then `true` if any credential is configured. */
  keyOk: boolean | null
  /** Active Anthropic subscription tier, or `null` when not on a subscription. */
  plan: string | null
}

async function readActivePlan(): Promise<string | null> {
  try {
    const snapshot = await getActiveAccount("anthropic")
    const id = snapshot.activeAccountId ?? null
    if (!id) return null
    const account = await getAccount("anthropic", id)
    if (account && account.credential.provider === "anthropic") {
      return account.credential.plan ?? null
    }
    return null
  } catch (err) {
    // No local account unlocked yet, or the vault read failed — treat as "no
    // tier to show" rather than surfacing an error in the header.
    loggers.chat.warn("active subscription plan read failed", {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function useCredentialStatus(target: CredentialTarget = {}): CredentialStatus {
  const [keyOk, setKeyOk] = useState<boolean | null>(null)
  const [plan, setPlan] = useState<string | null>(null)
  const [resolvedTarget, setResolvedTarget] = useState<string | null>(null)
  const { providerId, accountId, gateway = false } = target
  const targetKey = JSON.stringify({ providerId, accountId, gateway })
  const remoteKeys = useSyncExternalStore(
    subscribeRemoteHostKeyedProviders,
    remoteHostKeyedProviders,
    remoteHostKeyedProviders
  )
  // Re-probe whenever the unlocked local profile changes: `subscription_init`
  // (which pushes the bearer) only runs after unlock.
  const unlockedAccountId = useAccountStore((s) => s.unlockedAccountId)

  // Re-probe after any settings write (BYOK key entry bumps `updatedAt`), so the
  // standalone "No API key" badge clears the moment the user saves a key.
  const settingsRev = useSettingsStore((s) => s.settings?.updatedAt)

  const probe = useCallback(async (): Promise<{ keyOk: boolean | null; plan: string | null }> => {
    if (providerId === null) return { keyOk: null, plan: null }
    // Standalone (BYOK) mobile: the key lives in local settings, not the desktop
    // keyring — resolve it directly. No subscription tier in standalone mode.
    const standalone = isStandaloneChatMode()
    if (standalone && providerId === undefined) {
      const resolution = resolveStandaloneProvider(useSettingsStore.getState().settings, providerId)
      return { keyOk: resolution.kind === "resolved", plan: null }
    }
    if (providerId !== undefined) {
      const settings = useSettingsStore.getState().settings
      if (!settings) return { keyOk: null, plan: null }
      const definition = getSubscriptionProvider(providerId, settings.customProviders)
      const configured =
        settings.customProviders?.find((entry) => entry.id === providerId) ??
        settings.providerSettings?.[providerId]
      const selectedAccount =
        accountId ??
        (gateway
          ? (settings.defaultAccountIds?.[definition?.id ?? providerId] ??
            (settings.defaultProvider === providerId || settings.defaultProvider === definition?.id
              ? settings.defaultAccountId
              : undefined))
          : resolveAccountId(providerId, null, null, settings))
      const manual = Boolean(
        configured?.apiKey?.trim() ||
        configured?.apiKeys?.some((key) => key.trim()) ||
        hostProviderKey(providerId) ||
        (providerId === "anthropic" && !gateway && ccswitchApiKeyEnv(settings)) ||
        remoteKeys.has(providerId)
      )
      const accountAllowed = definition && (!gateway || definition.authMode !== "anthropic-oauth")
      if (standalone) {
        const localKey = Boolean(
          configured?.apiKey?.trim() || configured?.apiKeys?.some((key) => key.trim())
        )
        const resolved = resolveStandaloneProvider(settings, providerId)
        return {
          keyOk:
            localKey ||
            getAllProviders()[providerId]?.apiKeyRequired === false ||
            (resolved.kind === "resolved" && resolved.protocol === "bedrock"),
          plan: null,
        }
      }
      // A gateway with no account pin prefers a manual key over account defaults.
      if (gateway && accountId === undefined && manual) return { keyOk: true, plan: null }
      // Provider switches retain accountId; non-subscription providers do not consume it.
      if (definition && selectedAccount && !(gateway && accountId === null)) {
        if (!accountAllowed) return { keyOk: false, plan: null }
        const account = await getAccountDetail(definition.id, selectedAccount)
        return {
          keyOk: Boolean(account),
          plan: providerId === "anthropic" ? (account?.plan ?? null) : null,
        }
      }
      if (manual || getAllProviders()[providerId]?.apiKeyRequired === false) {
        return { keyOk: true, plan: null }
      }
      if (accountAllowed && !(gateway && accountId === null)) {
        const active = await getActiveAccount(definition.id)
        if (active.activeAccountId) {
          const account = await getAccountDetail(definition.id, active.activeAccountId)
          if (account)
            return { keyOk: true, plan: providerId === "anthropic" ? (account.plan ?? null) : null }
        }
      }
      if (providerId !== "anthropic" || gateway) return { keyOk: false, plan: null }
    }
    if (!isTauri()) return { keyOk: null, plan: null }
    const [key, bearer] = await Promise.all([
      hasApiKey().catch((err) => {
        loggers.chat.warn("hasApiKey check failed", {
          err: err instanceof Error ? err.message : String(err),
        })
        return null
      }),
      hasOauthBearer().catch((err) => {
        loggers.chat.warn("hasOauthBearer check failed", {
          err: err instanceof Error ? err.message : String(err),
        })
        return null
      }),
    ])
    // Tier is only meaningful for subscription (bearer) auth, not a bare API key.
    const nextPlan = bearer ? await readActivePlan() : null
    return {
      keyOk:
        key === true || bearer === true ? true : key === false && bearer === false ? false : null,
      plan: nextPlan,
    }
  }, [providerId, accountId, gateway, remoteKeys])

  useEffect(() => {
    let cancelled = false
    let revision = 0
    const run = () => {
      const request = ++revision
      void probe()
        .catch(() => ({ keyOk: null, plan: null }))
        .then((next) => {
          if (cancelled || request !== revision) return
          setKeyOk(next.keyOk)
          setPlan(next.plan)
          setResolvedTarget(targetKey)
        })
    }
    run()
    const unsubscribe = subscribeSubscriptionChanged(run)
    return () => {
      cancelled = true
      unsubscribe()
    }
    // `unlockedAccountId` re-runs the probe after a profile unlock; `settingsRev`
    // re-runs it after a BYOK key is saved in standalone mode.
  }, [probe, unlockedAccountId, settingsRev, targetKey])

  return resolvedTarget === targetKey ? { keyOk, plan } : { keyOk: null, plan: null }
}
