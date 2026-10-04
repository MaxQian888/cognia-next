"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"
import { useBiometricGuard, type GuardOutcome } from "@/hooks/use-biometric-guard"
import { useSettingsStore } from "@/stores/settings"

/** Shared policy for mobile export, general settings export and share preparation. */
export function useBackupExportGuard() {
  const guard = useBiometricGuard()
  const t = useTranslations("mobile.backup")
  const required =
    useSettingsStore((state) => state.settings?.biometricRequiredFor?.exportBackup) ??
    DEFAULT_BIOMETRIC_GUARD.exportBackup

  return useCallback(
    async <T>(action: () => Promise<T>): Promise<GuardOutcome<T>> => {
      if (!required) return { kind: "ok", value: await action() }
      return guard(
        {
          reason: t("exportBiometricReason"),
          title: t("exportBiometricTitle"),
          // Preserve recovery on genuinely unsupported/unenrolled devices.
          // The native guard still refuses bridge errors, hardware errors and lockout.
          fallthroughWhenUnavailable: true,
        },
        action
      )
    },
    [guard, required, t]
  )
}
