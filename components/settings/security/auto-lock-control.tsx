"use client"

/**
 * Idle auto-lock interval selector. Extracted from `SecuritySection` so the
 * Security & Privacy settings page and the account manage dialog's Security tab
 * render the same control instead of duplicating it. Reads/writes the single
 * `accountAutoLockMinutes` setting, so both surfaces stay in sync.
 */

import { useTranslations } from "next-intl"

import { SettingsRow } from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"

export const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60] as const

export function AutoLockControl() {
  const t = useTranslations("settings.security")
  const autoLockMinutes = useSettingsStore((s) => s.settings?.accountAutoLockMinutes ?? 0)
  const save = useSettingsStore((s) => s.save)

  const optionLabel = (minutes: number) =>
    minutes === 0 ? t("autoLock.off") : t("autoLock.option", { minutes })

  return (
    <SettingsRow label={t("autoLock.label")} description={t("autoLock.help")}>
      <select
        id="account-auto-lock"
        aria-label={t("autoLock.label")}
        value={autoLockMinutes}
        onChange={(e) => void save({ accountAutoLockMinutes: Number(e.target.value) })}
        className="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
        data-testid="account-auto-lock-select"
      >
        {AUTO_LOCK_OPTIONS.map((minutes) => (
          <option key={minutes} value={minutes}>
            {optionLabel(minutes)}
          </option>
        ))}
      </select>
    </SettingsRow>
  )
}

export default AutoLockControl
