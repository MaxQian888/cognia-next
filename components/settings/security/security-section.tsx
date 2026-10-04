"use client"

/**
 * Security & Privacy section (Wave 1.5).
 *
 * Surfaces the per-action biometric guard policy. Four independent toggles —
 * delete-pairing (sign-out / revoke), backup export, reveal-secrets, and the
 * mobile sign-out button. Devices without a biometric enrolled fall through on
 * the export path (so users aren't locked out of their own data) and block on
 * reveal-secrets (where a hard fail is preferable).
 *
 * Built on the shared settings toolkit (`SettingsCard` / `SettingsToggle`) so
 * the surface matches the rest of Settings, with a reduce-motion-aware stagger.
 */

import { useTranslations } from "next-intl"
import { GitBranchIcon, LockKeyholeIcon, ShieldCheckIcon } from "lucide-react"
import { motion } from "motion/react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { SettingsCard, SettingsToggle } from "@/components/settings/common/settings-section"
import { AutoLockControl } from "@/components/settings/security/auto-lock-control"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useBiometricBlockReason } from "@/hooks/use-biometric-block-reason"
import { useBiometricPolicyUpdate } from "@/hooks/use-biometric-policy-update"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"
import type { BiometricGuardPolicy } from "@cognia/agent-config-types"
import { STAGGER_CONTAINER, STAGGER_CHILD, useReducedMotionVariants } from "@/lib/ui/motion"
import { ContextInspector } from "@/components/governance/context-inspector"

const GUARD_ROWS: { key: keyof BiometricGuardPolicy; testid: string }[] = [
  { key: "deletePairing", testid: "biometric-delete-pairing" },
  { key: "exportBackup", testid: "biometric-export-backup" },
  { key: "revealSecrets", testid: "biometric-reveal-secrets" },
  { key: "signOut", testid: "biometric-sign-out" },
]

export function SecuritySection() {
  const t = useTranslations("settings.security")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const guard = useBiometricGuard()
  const blockReason = useBiometricBlockReason()
  const { updatePolicy, pending } = useBiometricPolicyUpdate(save)
  const [testing, setTesting] = useState(false)
  const testBusy = useRef(false)

  const policy: BiometricGuardPolicy = settings?.biometricRequiredFor ?? DEFAULT_BIOMETRIC_GUARD
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)

  const onTestPrompt = async () => {
    if (testBusy.current || pending) return
    testBusy.current = true
    setTesting(true)
    try {
      const outcome = await guard(
        {
          reason: t("testReason"),
          title: t("testTitle"),
          description: t("testDescription"),
          fallthroughWhenUnavailable: false,
        },
        async () => undefined
      )
      if (outcome.kind === "ok") toast.success(t("testSuccess"))
      else if (outcome.reason !== "cancelled") {
        toast.error(t("testBlocked", { reason: blockReason(outcome.reason) }))
      }
    } catch {
      toast.error(t("testError"))
    } finally {
      testBusy.current = false
      setTesting(false)
    }
  }

  return (
    <div className="space-y-6" data-testid="security-section" data-setting-id="biometric-guard">
      <SettingsCard
        icon={<ShieldCheckIcon className="size-4" />}
        title={t("title")}
        description={t("description")}
      >
        <motion.div
          variants={STAGGER_CONTAINER}
          initial="initial"
          animate="animate"
          className="space-y-3"
        >
          {GUARD_ROWS.map((row) => (
            <motion.div key={row.key} variants={childVariants} data-testid={row.testid}>
              <SettingsToggle
                id={`biometric-${row.key}`}
                label={t(`rows.${row.key}.label`)}
                description={t(`rows.${row.key}.help`)}
                checked={policy[row.key] ?? false}
                onCheckedChange={(v) => void updatePolicy({ [row.key]: v })}
                disabled={pending || testing}
              />
            </motion.div>
          ))}
        </motion.div>

        <Button
          variant="link"
          size="sm"
          className="px-0"
          onClick={() => void onTestPrompt()}
          disabled={pending || testing}
          data-testid="biometric-test"
        >
          {t(testing ? "testPending" : "testCta")}
        </Button>
      </SettingsCard>

      <SettingsCard
        icon={<LockKeyholeIcon className="size-4" />}
        title={t("autoLock.title")}
        description={t("autoLock.description")}
      >
        <AutoLockControl />
      </SettingsCard>

      <SettingsCard
        icon={<GitBranchIcon className="size-4" />}
        title={t("contextInspector.title")}
        description={t("contextInspector.description")}
      >
        <ContextInspector />
      </SettingsCard>
    </div>
  )
}
