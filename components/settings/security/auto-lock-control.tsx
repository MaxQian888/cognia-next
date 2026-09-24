"use client"

/**
 * Idle auto-lock interval selector. Extracted from `SecuritySection` so the
 * Security & Privacy settings page and the account manage dialog's Security tab
 * render the same control instead of duplicating it. Reads/writes the single
 * `accountAutoLockMinutes` setting, so both surfaces stay in sync.
 *
 * Inert, and labelled as such, while the unlocked profile opens without a
 * prompt on this device (the device-managed desktop workspace, or a profile
 * with "unlock automatically on this device"): `useAutoLockOnIdle` skips those,
 * because a lock the next reload undoes protects nothing. The stored value is
 * kept, so it applies again once the profile asks for its password.
 */

import { useTranslations } from "next-intl"

import { SettingsRow } from "@/components/settings/common/settings-section"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { unlocksWithoutPrompt } from "@/lib/accounts/desktop-local-account"
import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings"

export const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60] as const

export function AutoLockControl() {
  const t = useTranslations("settings.security")
  const autoLockMinutes = useSettingsStore((s) => s.settings?.accountAutoLockMinutes ?? 0)
  const save = useSettingsStore((s) => s.save)
  const inert = useAccountStore((s) =>
    unlocksWithoutPrompt(s.accounts.find((account) => account.id === s.unlockedAccountId))
  )

  const optionLabel = (minutes: number) =>
    minutes === 0 ? t("autoLock.off") : t("autoLock.option", { minutes })

  return (
    <SettingsRow
      label={t("autoLock.label")}
      description={t(inert ? "autoLock.inertHelp" : "autoLock.help")}
    >
      <NativeSelect
        id="account-auto-lock"
        aria-label={t("autoLock.label")}
        value={autoLockMinutes}
        disabled={inert}
        onChange={(e) => void save({ accountAutoLockMinutes: Number(e.target.value) })}
        className="text-xs"
        data-testid="account-auto-lock-select"
      >
        {AUTO_LOCK_OPTIONS.map((minutes) => (
          <NativeSelectOption key={minutes} value={minutes}>
            {optionLabel(minutes)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </SettingsRow>
  )
}

export default AutoLockControl
