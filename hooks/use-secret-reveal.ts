"use client"

/**
 * The gate behind Settings → Security → "Require biometrics to reveal secrets"
 * (`AppSettings.biometricRequiredFor.revealSecrets`).
 *
 * That row shipped with no enforcement anywhere: every API-key / token field in
 * the app flipped `type="password"` to `type="text"` on a bare `setState`, so
 * the switch was a preference nothing consulted. This hook is the single place
 * that answers "may this secret be shown right now", and every reveal toggle
 * over a STORED secret routes through it.
 *
 * What it does NOT gate:
 *   - Hiding. Re-masking a field is never a sensitive action, so callers keep
 *     calling `setState(false)` directly.
 *   - A passphrase or password the user is typing right now
 *     (`components/data/shared/passphrase-input.tsx`,
 *     `components/account/account-lock-screen.tsx`). Those are the user's own
 *     live input, not a secret the app is holding on their behalf, and gating
 *     them would prompt for a fingerprint to check one's own typing.
 *
 * Off (the shipped default, `DEFAULT_BIOMETRIC_GUARD.revealSecrets === false`)
 * the reveal runs synchronously in the same tick — adopting this hook changes
 * nothing until the user turns the row on. On a platform with no biometric
 * enrolled the underlying guard falls through, so desktop and web keep working.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"

export type SecretRevealOutcome = "revealed" | "blocked"

export type SecretRevealGate = (reveal: () => void) => Promise<SecretRevealOutcome>

export function useSecretReveal(): SecretRevealGate {
  const guard = useBiometricGuard()
  const t = useTranslations("settings.security.revealGate")
  const required =
    useSettingsStore((s) => s.settings?.biometricRequiredFor?.revealSecrets) ??
    DEFAULT_BIOMETRIC_GUARD.revealSecrets

  return useCallback(
    async (reveal: () => void) => {
      if (!required) {
        reveal()
        return "revealed"
      }
      const outcome = await guard(
        {
          reason: t("reason"),
          title: t("title"),
          description: t("description"),
        },
        async () => {
          reveal()
        }
      )
      return outcome.kind === "ok" ? "revealed" : "blocked"
    },
    [guard, required, t]
  )
}
