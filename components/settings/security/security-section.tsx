"use client"

/**
 * Security & Privacy section (Wave 1.5).
 *
 * Surfaces the per-action biometric guard policy. Three independent
 * toggles — sign-out (i.e. delete-pairing), backup export, and reveal-
 * secrets. Devices without a biometric enrolled will fall through on the
 * export path (so users aren't locked out of their own data) and block
 * on reveal-secrets (where a hard fail is preferable).
 */

import { useTranslations } from "next-intl"
import { ShieldCheckIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"
import type { BiometricGuardPolicy } from "@/lib/claude/types"

export function SecuritySection() {
  const t = useTranslations("settings.security")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const guard = useBiometricGuard()

  const policy: BiometricGuardPolicy = settings?.biometricRequiredFor ?? DEFAULT_BIOMETRIC_GUARD

  const update = (patch: Partial<BiometricGuardPolicy>) => {
    void save({
      biometricRequiredFor: { ...policy, ...patch },
    })
  }

  const onTestPrompt = () => {
    void guard(
      {
        reason: t("testReason"),
        title: t("testTitle"),
        description: t("testDescription"),
        fallthroughWhenUnavailable: false,
      },
      async () => undefined
    )
  }

  return (
    <div className="space-y-6" data-testid="security-section">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-4">
        <Row
          label={t("rows.deletePairing.label")}
          help={t("rows.deletePairing.help")}
          checked={policy.deletePairing}
          onChange={(v) => update({ deletePairing: v })}
          testid="biometric-delete-pairing"
        />
        <Row
          label={t("rows.exportBackup.label")}
          help={t("rows.exportBackup.help")}
          checked={policy.exportBackup}
          onChange={(v) => update({ exportBackup: v })}
          testid="biometric-export-backup"
        />
        <Row
          label={t("rows.revealSecrets.label")}
          help={t("rows.revealSecrets.help")}
          checked={policy.revealSecrets}
          onChange={(v) => update({ revealSecrets: v })}
          testid="biometric-reveal-secrets"
        />
      </div>

      <div>
        <button
          type="button"
          className="text-sm text-primary underline-offset-2 hover:underline"
          onClick={onTestPrompt}
          data-testid="biometric-test"
        >
          {t("testCta")}
        </button>
      </div>
    </div>
  )
}

interface RowProps {
  label: string
  help: string
  checked: boolean
  onChange: (next: boolean) => void
  testid: string
}

function Row({ label, help, checked, onChange, testid }: RowProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testid} />
    </div>
  )
}
