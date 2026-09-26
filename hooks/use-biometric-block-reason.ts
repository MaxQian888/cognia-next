"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import type { BiometricBlockReason } from "@/hooks/use-biometric-guard"

/**
 * The sentence to show for a `useBiometricGuard()` refusal.
 *
 * The guard reports *why* it blocked as a code (`lockout`, `unavailable`, …).
 * Every caller used to interpolate that code straight into its toast, so a
 * locked-out phone read "Approval not completed (lockout)." This is the one
 * place those codes become words; callers wrap the result in their own
 * "what did not happen" message.
 *
 * Covers every blocked reason, `cancelled` included, even though most callers
 * stay quiet on a cancel — the mapping is total so a new caller never has to
 * fall back to the raw code.
 */
export function useBiometricBlockReason(): (reason: BiometricBlockReason) => string {
  const t = useTranslations("common.biometricBlocked")
  return useCallback((reason: BiometricBlockReason) => t(reason), [t])
}
