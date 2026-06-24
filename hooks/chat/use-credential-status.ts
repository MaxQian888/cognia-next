"use client"

// Reactive Claude credential status for the chat header.
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

import { useCallback, useEffect, useState } from "react"

import { isTauri } from "@/lib/tauri"
import { hasApiKey, hasOauthBearer } from "@/lib/claude/ipc"
import { getAccount, getActiveAccount } from "@/lib/subscription/core/transport"
import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { useAccountStore } from "@/stores/account/account-store"
import { loggers } from "@/lib/logging"

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

export function useCredentialStatus(): CredentialStatus {
  const [keyOk, setKeyOk] = useState<boolean | null>(null)
  const [plan, setPlan] = useState<string | null>(null)
  // Re-probe whenever the unlocked local profile changes: `subscription_init`
  // (which pushes the bearer) only runs after unlock.
  const unlockedAccountId = useAccountStore((s) => s.unlockedAccountId)

  const probe = useCallback(async (): Promise<{ keyOk: boolean | null; plan: string | null }> => {
    if (!isTauri()) return { keyOk: null, plan: null }
    const [key, bearer] = await Promise.all([
      hasApiKey().catch((err) => {
        loggers.chat.warn("hasApiKey check failed", {
          err: err instanceof Error ? err.message : String(err),
        })
        return false
      }),
      hasOauthBearer().catch((err) => {
        loggers.chat.warn("hasOauthBearer check failed", {
          err: err instanceof Error ? err.message : String(err),
        })
        return false
      }),
    ])
    // Tier is only meaningful for subscription (bearer) auth, not a bare API key.
    const nextPlan = bearer ? await readActivePlan() : null
    return { keyOk: key || bearer, plan: nextPlan }
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = () => {
      void probe().then((next) => {
        if (cancelled) return
        setKeyOk(next.keyOk)
        setPlan(next.plan)
      })
    }
    run()
    const unsubscribe = subscribeSubscriptionChanged(run)
    return () => {
      cancelled = true
      unsubscribe()
    }
    // `unlockedAccountId` in the deps re-runs the probe after a profile unlock.
  }, [probe, unlockedAccountId])

  return { keyOk, plan }
}
