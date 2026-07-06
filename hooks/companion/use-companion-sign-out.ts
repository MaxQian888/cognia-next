"use client"

/**
 * Composite "退出登录" hook for the mobile profile screen. One press
 * clears both:
 *   • the Anthropic subscription credential — `useActiveAnthropicCredential().signOut()`
 *     (no-op outside Tauri, but harmless to call universally).
 *   • the pairing JWT — `clearCompanionConfig()` (wipes SecureStorage *and*
 *     the transport's in-memory config cache).
 *
 * The call is gated by `verify()` from `lib/capacitor/biometric.ts` when
 * `AppSettings.biometricRequiredFor.signOut` is true (default). After a
 * successful clear we navigate to `/pair` so the user is funnelled
 * straight into the re-pair flow.
 */

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"

import { verify, type VerifyOutcome } from "@/lib/capacitor/biometric"
import { clearCompanionConfig } from "@/lib/tauri/transport-companion"
import { useActiveAnthropicCredential } from "@/lib/subscription/anthropic/hooks"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"

export type SignOutOutcome =
  | { kind: "ok" }
  | { kind: "blocked"; reason: "cancelled" | "lockout" | "error"; message?: string }

export interface UseCompanionSignOutOptions {
  /** Localised biometric prompt copy. */
  prompt: { reason: string; title?: string; description?: string }
  /** Where to send the user once the clear completes. */
  redirectTo?: string
}

export interface UseCompanionSignOutResult {
  signOut: () => Promise<SignOutOutcome>
  pending: boolean
}

export function useCompanionSignOut(opts: UseCompanionSignOutOptions): UseCompanionSignOutResult {
  const { prompt, redirectTo = "/pair" } = opts
  const router = useRouter()
  const policy = useSettingsStore(
    (s) => s.settings?.biometricRequiredFor ?? DEFAULT_BIOMETRIC_GUARD
  )
  const { signOut: anthropicSignOut } = useActiveAnthropicCredential()
  const [pending, setPending] = useState(false)

  const signOut = useCallback(async (): Promise<SignOutOutcome> => {
    if (pending) return { kind: "blocked", reason: "error", message: "in-flight" }
    setPending(true)
    try {
      // Biometric gate — skipped when the policy is off OR when the
      // platform doesn't support biometric (verify() returns
      // `unavailable`, which we treat as a pass-through).
      if (policy.signOut) {
        const outcome: VerifyOutcome = await verify({
          reason: prompt.reason,
          title: prompt.title,
          description: prompt.description,
        })
        if (outcome.kind === "cancelled") {
          return { kind: "blocked", reason: "cancelled" }
        }
        if (outcome.kind === "lockout") {
          return { kind: "blocked", reason: "lockout" }
        }
        if (outcome.kind === "error") {
          return { kind: "blocked", reason: "error", message: outcome.message }
        }
        // "verified" or "unavailable" both fall through.
      }

      // Order matters: clear the subscription first (the Tauri vault path
      // is the one most likely to fail noisily — leaving the pair JWT
      // intact would let the user retry). On Capacitor anthropicSignOut
      // is a no-op so this is just the pair clear.
      try {
        await anthropicSignOut()
      } catch {
        // Swallow — `setActiveAccount(null)` failing on web is benign and
        // would otherwise block the pair clear that mobile actually
        // depends on.
      }
      // clearCompanionConfig() — NOT companionStorage().clear() — so the
      // transport's module-level `cachedConfig` is wiped too. Clearing only
      // the on-disk backend leaves the live transport believing it is still
      // paired (stale WS, stale `loadCompanionConfig()`), which then strands
      // the re-pair flow.
      await clearCompanionConfig()

      router.replace(redirectTo)
      return { kind: "ok" }
    } finally {
      setPending(false)
    }
  }, [
    pending,
    policy.signOut,
    prompt.description,
    prompt.reason,
    prompt.title,
    anthropicSignOut,
    redirectTo,
    router,
  ])

  return { signOut, pending }
}
