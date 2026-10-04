"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DEFAULT_BIOMETRIC_GUARD, type BiometricGuardPolicy } from "@cognia/agent-config-types"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useBiometricBlockReason } from "@/hooks/use-biometric-block-reason"
import type { SettingsPatchFn } from "@/hooks/use-settings-patch"
import { isMobile } from "@/lib/capacitor/_shared"
import { useSettingsStore } from "@/stores/settings"
import { useAccountStore } from "@/stores/account/account-store"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

function currentPolicy(): BiometricGuardPolicy {
  return {
    ...DEFAULT_BIOMETRIC_GUARD,
    ...useSettingsStore.getState().settings?.biometricRequiredFor,
  }
}

function currentScope(): string {
  const { activeAccountId, unlockedAccountId } = useAccountStore.getState()
  return JSON.stringify([activeAccountId, unlockedAccountId, getActiveRuntimeTargetContext()])
}

/** Shared by the three policy editors; disabling protection is itself protected. */
export function useBiometricPolicyUpdate(save: SettingsPatchFn) {
  const guard = useBiometricGuard()
  const blockReason = useBiometricBlockReason()
  const t = useTranslations("settings.security")
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const updatePolicy = useCallback(
    async (patch: Partial<BiometricGuardPolicy>): Promise<void> => {
      if (busy.current) return
      busy.current = true
      setPending(true)
      try {
        const scope = currentScope()
        const before = currentPolicy()
        const weakening = Object.entries(patch).some(
          ([key, enabled]) =>
            enabled === false && before[key as keyof BiometricGuardPolicy] === true
        )
        const persist = async () => {
          if (!mounted.current) return
          if (scope !== currentScope()) {
            toast.error(t("policyChangeContextChanged"))
            return
          }
          // Another settings surface can update a different flag while the
          // system prompt is open. Preserve that latest policy when saving.
          await save({ biometricRequiredFor: { ...currentPolicy(), ...patch } })
        }
        // Web and desktop do not ship the native prompt. On phones, missing
        // enrollment or unavailable hardware must not disable an enabled gate.
        if (weakening && isMobile()) {
          const outcome = await guard(
            {
              reason: t("policyChangeReason"),
              title: t("policyChangeTitle"),
              fallthroughWhenUnavailable: false,
            },
            persist
          )
          if (mounted.current && outcome.kind === "blocked" && outcome.reason !== "cancelled") {
            toast.error(t("policyChangeBlocked", { reason: blockReason(outcome.reason) }))
          }
        } else {
          await persist()
        }
      } catch {
        if (mounted.current) toast.error(t("policyChangeFailed"))
      } finally {
        busy.current = false
        if (mounted.current) setPending(false)
      }
    },
    [blockReason, guard, save, t]
  )

  return { updatePolicy, pending }
}
