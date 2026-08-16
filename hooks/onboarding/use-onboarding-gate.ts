"use client"

import { useEffect, useMemo, useState } from "react"
import { isOnboardingSettled } from "@cognia/agent-config-types"

import { countSessions } from "@/lib/db/sessions"
import { detectPlatform } from "@/lib/platform/detect"
import { migrateLegacyOnboarding } from "@/lib/onboarding/migrate-legacy"
import { resolveOnboardingShell } from "@/lib/onboarding/shell"
import { shouldEnterOnboarding } from "@/lib/onboarding/gate"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { loggers } from "@cognia/logging"
import type { OnboardingShell } from "@cognia/agent-config-types"

const log = loggers.ui.child("onboarding-gate")

export type OnboardingGateStatus = "resolving" | "enter" | "skip"

export interface OnboardingGateResult {
  status: OnboardingGateStatus
  /** Meaningful once `status` leaves `"resolving"`. */
  shell: OnboardingShell
}

/**
 * Decide, once per boot, whether this device should be routed into the
 * first-run flow (ADR-0122).
 *
 * **Why a single hook rather than per-shell `useEffect`s.** The predecessor ran
 * the same check twice — in `desktop-chat-workspace.tsx` and
 * `app-shell-mobile.tsx` — and the two copies had already drifted. With four
 * shells to serve, four copies would drift faster.
 *
 * **Readiness is the whole difficulty.** The inputs land asynchronously, and
 * acting before they are all in produces the two failure modes this hook
 * exists to prevent:
 *
 *  - reading un-hydrated settings makes a long-time user look like a fresh
 *    install, so the flow flashes over their existing app;
 *  - reading a session count before Dexie answers makes an existing user with
 *    chats look like a first run.
 *
 * So the effect does not run at all until settings are hydrated, and the count
 * is awaited rather than subscribed. Callers render nothing while `resolving`.
 *
 * **A one-shot count, not a live query.** The gate asks "has this person ever
 * had a conversation here?", which is a boot-time fact. Subscribing would
 * re-fire on every session the user creates *inside* the flow — including the
 * one the first-run step opens — and a live re-evaluation would yank them out
 * of a flow they had already started.
 *
 * **Settlement is read live, and that is the one exception to the latch.**
 * `skippedAt` / `completedAt` are written by the flow's own exit paths right
 * before it navigates home. If the boot verdict stayed `"enter"` past that
 * write, `OnboardingGate` would bounce the user straight back to `/onboarding`
 * the moment the pathname changed — every exit became a no-op. Settlement is a
 * one-way, user-driven transition, so overriding to `"skip"` once it lands can
 * only ever release the user, never pull them out of a flow mid-way.
 */
export function useOnboardingGate(): OnboardingGateResult {
  const loaded = useSettingsStore((s) => s.loaded)
  const settings = useSettingsStore((s) => s.settings)
  const mobileRuntimeMode = settings?.mobileRuntimeMode

  const shell = useMemo(
    () => resolveOnboardingShell(detectPlatform(), mobileRuntimeMode),
    [mobileRuntimeMode]
  )

  const [status, setStatus] = useState<OnboardingGateStatus>("resolving")

  // Live, unlike the count above — see the docblock. `onboardingDismissedAt`
  // is the pre-migration legacy stamp; `shouldEnterOnboarding` honours it too.
  const settled =
    !!settings &&
    (isOnboardingSettled(settings.onboardingProgress) || !!settings.onboardingDismissedAt)

  useEffect(() => {
    if (!loaded) return
    const current = useSettingsStore.getState().settings
    if (!current) return
    let cancelled = false

    void (async () => {
      // One-way migration of the pre-ADR-0122 dismissal stamp. Awaited rather
      // than fire-and-forget so the record is durable before we decide — a
      // crash between the two would otherwise re-prompt an upgrading user.
      // `shouldEnterOnboarding` reads the legacy stamp too, so the verdict is
      // the same either way; this only protects the *next* boot.
      const migrated = migrateLegacyOnboarding(current)
      if (migrated) {
        log.info("migrating legacy onboarding dismissal", { path: migrated.path })
        try {
          await useSettingsStore.getState().save({ onboardingProgress: migrated })
        } catch (err) {
          log.error("legacy onboarding migration failed", err)
        }
      }
      if (cancelled) return

      const sessionCount = await countSessions().catch((err) => {
        // A failed count must not trap a real first-run user outside the flow,
        // nor drop an existing user into it. Treating it as "has sessions" is
        // the conservative half: the worst case is an un-onboarded user who
        // reaches the app and can still start setup from Settings.
        log.error("session count failed; assuming an existing install", err)
        return 1
      })
      if (cancelled) return

      const next = shouldEnterOnboarding(
        useSettingsStore.getState().settings ?? current,
        sessionCount
      )
        ? "enter"
        : "skip"
      log.info("onboarding gate resolved", { status: next, shell, sessionCount })
      setStatus(next)
    })()

    return () => {
      cancelled = true
    }
    // Deliberately keyed on `loaded` alone. Re-running on every `settings`
    // identity change would revisit a verdict that is meant to be latched —
    // and the migration write above changes that identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  // A settled record outranks the boot verdict, but never pre-empts
  // `"resolving"`: hydration is still what protects a long-time user with no
  // record, and the migration write in the effect must still get to run.
  return { status: settled && status === "enter" ? "skip" : status, shell }
}
