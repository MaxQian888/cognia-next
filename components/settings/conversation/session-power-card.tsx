"use client"

/**
 * Settings → Conversation → "Screen & power during a run": the default every
 * conversation inherits, using the same picker the session sheet shows so the
 * two can never describe the behaviour differently.
 *
 * Absent means `allowScreenOff`, which is what the app did before this setting
 * existed. Writing the resolved value back on first touch would be a lie about
 * what the user chose, so only an actual click persists anything.
 */

import { useTranslations } from "next-intl"
import { SunMoonIcon } from "lucide-react"

import { SessionPowerPicker } from "@/components/power/session-power-picker"
import { resolveDefaultPowerMode } from "@/lib/power/session-power-policy"
import { useSettingsStore } from "@/stores/settings"
import type { SessionPowerMode } from "@cognia/agent-config-types"
import { SettingsCard } from "../common/settings-section"

export function SessionPowerCard() {
  const t = useTranslations("sessionPower")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const current = resolveDefaultPowerMode(settings)

  return (
    <SettingsCard
      icon={<SunMoonIcon className="size-5" />}
      title={t("settings.title")}
      description={t("settings.description")}
    >
      <div data-testid="session-power-card">
        <SessionPowerPicker
          value={current}
          appDefault={current}
          idPrefix="settings-power"
          onValueChange={(next) => void save({ sessionPowerPolicy: next as SessionPowerMode })}
        />
      </div>
    </SettingsCard>
  )
}

export default SessionPowerCard
